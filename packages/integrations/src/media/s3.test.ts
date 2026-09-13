import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createObjectStorageProvider } from "./index";

interface S3Capture {
  single?: Buffer;
  multipartStarted: boolean;
  multipartCompleted: boolean;
  parts: Map<number, Buffer>;
}

function xml(response: ServerResponse, value: string) {
  response.writeHead(200, { "content-type": "application/xml" });
  response.end(value);
}

async function withFakeS3(
  run: (endpoint: string, capture: S3Capture) => Promise<void>,
) {
  const capture: S3Capture = {
    multipartStarted: false,
    multipartCompleted: false,
    parts: new Map(),
  };
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const body = Buffer.concat(chunks);
      const url = new URL(request.url ?? "/", "http://s3.test");

      if (request.method === "POST" && url.searchParams.has("uploads")) {
        capture.multipartStarted = true;
        return xml(
          response,
          '<?xml version="1.0" encoding="UTF-8"?>' +
            '<InitiateMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
            "<Bucket>private-bucket</Bucket><Key>org/large.bin</Key>" +
            "<UploadId>test-upload</UploadId></InitiateMultipartUploadResult>",
        );
      }

      if (request.method === "PUT" && url.searchParams.has("partNumber")) {
        const partNumber = Number(url.searchParams.get("partNumber"));
        capture.parts.set(partNumber, body);
        response.writeHead(200, { etag: `"part-${partNumber}"` });
        return response.end();
      }

      if (request.method === "POST" && url.searchParams.has("uploadId")) {
        capture.multipartCompleted = true;
        return xml(
          response,
          '<?xml version="1.0" encoding="UTF-8"?>' +
            '<CompleteMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
            "<Location>http://s3.test/private-bucket/org/large.bin</Location>" +
            "<Bucket>private-bucket</Bucket><Key>org/large.bin</Key>" +
            '<ETag>"complete"</ETag></CompleteMultipartUploadResult>',
        );
      }

      capture.single = body;
      response.writeHead(200, { etag: '"single"' });
      response.end();
    } catch {
      response.statusCode = 500;
      response.end();
    }
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`, capture);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

function remoteStorage(endpoint: string) {
  return createObjectStorageProvider({
    APP_ENV: "production",
    OBJECT_STORAGE_PROVIDER: "r2",
    S3_BUCKET: "private-bucket",
    S3_REGION: "auto",
    S3_ENDPOINT: endpoint,
    S3_FORCE_PATH_STYLE: "true",
    S3_ACCESS_KEY_ID: "test-access-key",
    S3_SECRET_ACCESS_KEY: "test-secret-key",
  });
}

describe("R2-compatible object uploads", () => {
  it("signs downloads with an attachment filename", async () => {
    const signed = await remoteStorage(
      "https://storage.example.test",
    ).createSignedDownloadUrl({
      key: "org/photo.jpg",
      expiresInSeconds: 300,
      downloadFilename: "müşteri-fotoğrafı.jpg",
    });
    const url = new URL(signed.url);

    expect(url.searchParams.get("response-content-disposition")).toBe(
      "attachment; filename=\"m__teri-foto_raf_.jpg\"; filename*=UTF-8''m%C3%BC%C5%9Fteri-foto%C4%9Fraf%C4%B1.jpg",
    );
  });

  it("uploads a multi-chunk stream without consuming it before AWS checksum handling", async () => {
    await withFakeS3(async (endpoint, capture) => {
      const payload = Buffer.from("abcdef");
      const result = await remoteStorage(endpoint).putObject({
        key: "org/file.txt",
        body: Readable.from([payload.subarray(0, 3), payload.subarray(3)]),
        contentType: "text/plain",
      });

      expect(capture.single).toEqual(payload);
      expect(capture.multipartStarted).toBe(false);
      expect(result).toEqual({
        key: "org/file.txt",
        size: payload.length,
        contentType: "text/plain",
        sha256: createHash("sha256").update(payload).digest("hex"),
      });
    });
  });

  it("uses multipart upload for streams larger than one managed part", async () => {
    await withFakeS3(async (endpoint, capture) => {
      const payload = Buffer.alloc(6 * 1024 * 1024, 0x61);
      const result = await remoteStorage(endpoint).putObject({
        key: "org/large.bin",
        body: Readable.from([
          payload.subarray(0, 3 * 1024 * 1024),
          payload.subarray(3 * 1024 * 1024),
        ]),
        contentType: "application/octet-stream",
      });
      const uploaded = Buffer.concat(
        [...capture.parts.entries()]
          .sort(([left], [right]) => left - right)
          .map(([, part]) => part),
      );

      expect(capture.multipartStarted).toBe(true);
      expect(capture.multipartCompleted).toBe(true);
      expect(capture.parts.size).toBe(2);
      expect(uploaded.equals(payload)).toBe(true);
      expect(result.size).toBe(payload.length);
      expect(result.sha256).toBe(
        createHash("sha256").update(payload).digest("hex"),
      );
    });
  }, 20_000);
});
