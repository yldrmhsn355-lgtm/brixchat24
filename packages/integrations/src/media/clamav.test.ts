import {
  createServer,
  type AddressInfo,
  type Server,
  type Socket,
} from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createMalwareScanner } from "./index";

const servers = new Set<Server>();
const sockets = new Set<Socket>();

async function closeServer(server: Server) {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function startServer(
  onConnection: (socket: Socket) => void,
  allowHalfOpen = false,
) {
  const server = createServer({ allowHalfOpen }, (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    onConnection(socket);
  });
  servers.add(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return (server.address() as AddressInfo).port;
}

async function closedPort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  await closeServer(server);
  return port;
}

function scannerFor(port: number, healthTimeoutMs = 250, scanTimeoutMs = 250) {
  return createMalwareScanner({
    MALWARE_SCANNER_PROVIDER: "clamav",
    CLAMAV_HOST: "127.0.0.1",
    CLAMAV_PORT: String(port),
    CLAMAV_HEALTHCHECK_TIMEOUT_MS: String(healthTimeoutMs),
    CLAMAV_SCAN_TIMEOUT_MS: String(scanTimeoutMs),
  });
}

function parseInstreamRequest(value: Buffer): {
  complete: boolean;
  valid: boolean;
  frames?: number;
  payload?: Buffer;
} {
  const command = Buffer.from("zINSTREAM\0");
  if (value.length < command.length) return { complete: false, valid: true };
  if (!value.subarray(0, command.length).equals(command))
    return { complete: true, valid: false };
  let offset = command.length;
  const payload: Buffer[] = [];
  while (offset + 4 <= value.length) {
    const size = value.readUInt32BE(offset);
    offset += 4;
    if (size === 0)
      return {
        complete: true,
        valid: offset === value.length,
        frames: payload.length,
        payload: Buffer.concat(payload),
      };
    if (offset + size > value.length) return { complete: false, valid: true };
    payload.push(value.subarray(offset, offset + size));
    offset += size;
  }
  return { complete: false, valid: true };
}

afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await Promise.all([...servers].map(closeServer));
  servers.clear();
});

describe("ClamAV health checks", () => {
  it("reports healthy only after a clamd PONG", async () => {
    let command = Buffer.alloc(0);
    const port = await startServer((socket) => {
      socket.on("data", (chunk: Buffer) => {
        command = Buffer.concat([command, chunk]);
        if (command.includes(0)) socket.end(Buffer.from("PONG\0"));
      });
    });

    await expect(scannerFor(port).healthCheck()).resolves.toEqual({
      healthy: true,
    });
    expect(command).toEqual(Buffer.from("zPING\0"));
  });

  it("reports unhealthy when clamd refuses the connection", async () => {
    await expect(scannerFor(await closedPort()).healthCheck()).resolves.toEqual(
      { healthy: false },
    );
  });

  it("reports unhealthy when clamd does not answer before the deadline", async () => {
    const port = await startServer(() => {
      // Accept the connection but intentionally never answer the PING.
    });

    await expect(scannerFor(port, 25).healthCheck()).resolves.toEqual({
      healthy: false,
    });
  });
});

describe("ClamAV streaming scans", () => {
  it("keeps the NUL-terminated chunked INSTREAM protocol", async () => {
    let request = Buffer.alloc(0);
    let responded = false;
    const port = await startServer((socket) => {
      socket.on("data", (chunk: Buffer) => {
        request = Buffer.concat([request, chunk]);
        const parsed = parseInstreamRequest(request);
        if (responded || !parsed.complete) return;
        responded = true;
        socket.end(
          parsed.valid
            ? Buffer.from("stream: OK\0")
            : Buffer.from("stream: protocol error ERROR\0"),
        );
      });
    });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from("first"));
        controller.enqueue(Buffer.from("second"));
        controller.close();
      },
    });

    await expect(scannerFor(port).scan({ stream })).resolves.toEqual({
      status: "clean",
    });
    const parsed = parseInstreamRequest(request);
    expect(parsed).toMatchObject({ complete: true, valid: true });
    expect(parsed.frames).toBeGreaterThan(0);
    expect(parsed.payload).toEqual(Buffer.from("firstsecond"));
  });

  it("returns failed when clamd refuses the scan connection", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from("payload"));
        controller.close();
      },
    });

    await expect(
      scannerFor(await closedPort()).scan({ stream }),
    ).resolves.toEqual({ status: "failed" });
  });

  it("returns failed for a malformed clamd response", async () => {
    let request = Buffer.alloc(0);
    const port = await startServer((socket) => {
      socket.on("data", (chunk: Buffer) => {
        request = Buffer.concat([request, chunk]);
        if (parseInstreamRequest(request).complete)
          socket.end(Buffer.from("not-clamav: OK\0"));
      });
    });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from("payload"));
        controller.close();
      },
    });

    await expect(scannerFor(port).scan({ stream })).resolves.toEqual({
      status: "failed",
    });
  });

  it("returns failed for a truncated clean response without a terminator", async () => {
    let request = Buffer.alloc(0);
    const port = await startServer((socket) => {
      socket.on("data", (chunk: Buffer) => {
        request = Buffer.concat([request, chunk]);
        if (parseInstreamRequest(request).complete)
          socket.end(Buffer.from("stream: OK"));
      });
    });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from("payload"));
        controller.close();
      },
    });

    await expect(scannerFor(port).scan({ stream })).resolves.toEqual({
      status: "failed",
    });
  });

  it("reports a FOUND response as infected", async () => {
    let request = Buffer.alloc(0);
    const port = await startServer((socket) => {
      socket.on("data", (chunk: Buffer) => {
        request = Buffer.concat([request, chunk]);
        if (parseInstreamRequest(request).complete)
          socket.end(Buffer.from("stream: Eicar-Test-Signature FOUND\0"));
      });
    });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from("payload"));
        controller.close();
      },
    });

    await expect(scannerFor(port).scan({ stream })).resolves.toEqual({
      status: "infected",
      signature: "stream: Eicar-Test-Signature FOUND",
    });
  });

  it("bounds a stalled scan and returns failed", async () => {
    const port = await startServer(() => {
      // Keep the writable side open and intentionally never answer INSTREAM.
    }, true);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from("payload"));
        controller.close();
      },
    });
    const startedAt = Date.now();

    await expect(scannerFor(port, 250, 25).scan({ stream })).resolves.toEqual({
      status: "failed",
    });
    expect(Date.now() - startedAt).toBeLessThan(250);
  });
});
