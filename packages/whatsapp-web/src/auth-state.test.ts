import { describe, expect, it } from "vitest";
import {
  buildWhatsAppWebAuthState,
  type WhatsAppWebAuthStorage,
} from "./auth-state";

class MemoryAuthStorage implements WhatsAppWebAuthStorage {
  credentials: string | null = null;
  keys = new Map<string, string>();
  batchCalls = 0;

  async readCredentials(): Promise<string | null> {
    return this.credentials;
  }
  async writeCredentials(
    _channelId: string,
    serialized: string,
  ): Promise<void> {
    this.credentials = serialized;
  }
  async readKey(
    _channelId: string,
    type: string,
    id: string,
  ): Promise<string | null> {
    return this.keys.get(`${type}:${id}`) ?? null;
  }
  async applyKeyBatch(
    _channelId: string,
    mutations: Array<{
      type: string;
      id: string;
      serialized: string | null;
    }>,
  ): Promise<void> {
    this.batchCalls += 1;
    for (const mutation of mutations) {
      const key = `${mutation.type}:${mutation.id}`;
      if (mutation.serialized === null) this.keys.delete(key);
      else this.keys.set(key, mutation.serialized);
    }
  }
  async deleteAll(): Promise<void> {
    this.credentials = null;
    this.keys.clear();
  }
}

describe("WhatsApp Web auth state", () => {
  it("persists credentials and every Baileys v7 key family in one batch", async () => {
    const storage = new MemoryAuthStorage();
    const { state, saveCredentials } = await buildWhatsAppWebAuthState(
      "channel-1",
      storage,
    );
    await saveCredentials();
    expect(storage.credentials).toContain("noiseKey");

    const families = [
      "pre-key",
      "session",
      "sender-key",
      "sender-key-memory",
      "app-state-sync-key",
      "app-state-sync-version",
      "lid-mapping",
      "device-list",
      "tctoken",
      "identity-key",
    ] as const;
    const batch = Object.fromEntries(
      families.map((family) => [
        family,
        { [`${family}-id`]: { family, bytes: Buffer.from([1, 2, 3]) } },
      ]),
    );
    await state.keys.set(batch as never);

    expect(storage.batchCalls).toBe(1);
    expect([...storage.keys.keys()].sort()).toEqual(
      families.map((family) => `${family}:${family}-id`).sort(),
    );
  });

  it("deletes a key when Baileys writes null", async () => {
    const storage = new MemoryAuthStorage();
    const { state } = await buildWhatsAppWebAuthState("channel-1", storage);
    await state.keys.set({
      "lid-mapping": { one: "905551234567@s.whatsapp.net" },
    } as never);
    await state.keys.set({ "lid-mapping": { one: null } } as never);
    expect(storage.keys.size).toBe(0);
    expect(storage.batchCalls).toBe(2);
  });
});
