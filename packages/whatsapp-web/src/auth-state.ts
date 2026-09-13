import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataTypeMap,
} from "@whiskeysockets/baileys";

export interface WhatsAppWebAuthStorage {
  readCredentials(channelId: string): Promise<string | null>;
  writeCredentials(channelId: string, serialized: string): Promise<void>;
  readKey(
    channelId: string,
    type: string,
    id: string,
  ): Promise<string | null>;
  applyKeyBatch(
    channelId: string,
    mutations: WhatsAppWebAuthKeyMutation[],
  ): Promise<void>;
  deleteAll(channelId: string): Promise<void>;
}

export type WhatsAppWebAuthKeyMutation = {
  type: string;
  id: string;
  serialized: string | null;
};

export function serializeBaileysValue(value: unknown): string {
  return JSON.stringify(value, BufferJSON.replacer);
}

export function deserializeBaileysValue<T>(value: string): T {
  return JSON.parse(value, BufferJSON.reviver) as T;
}

export async function buildWhatsAppWebAuthState(
  channelId: string,
  storage: WhatsAppWebAuthStorage,
): Promise<{
  state: AuthenticationState;
  saveCredentials: () => Promise<void>;
}> {
  const serialized = await storage.readCredentials(channelId);
  const credentials = serialized
    ? deserializeBaileysValue<AuthenticationCreds>(serialized)
    : initAuthCreds();
  const state: AuthenticationState = {
    creds: credentials,
    keys: {
      get: async (type, ids) => {
        const output: { [id: string]: SignalDataTypeMap[typeof type] } = {};
        await Promise.all(
          ids.map(async (id) => {
            const value = await storage.readKey(channelId, type, id);
            if (!value) return;
            const parsed = deserializeBaileysValue<
              SignalDataTypeMap[typeof type]
            >(value);
            output[id] =
              type === "app-state-sync-key" && parsed
                ? (proto.Message.AppStateSyncKeyData.fromObject(
                    parsed as never,
                  ) as unknown as SignalDataTypeMap[typeof type])
                : parsed;
          }),
        );
        return output;
      },
      set: async (data) => {
        const mutations: WhatsAppWebAuthKeyMutation[] = [];
        for (const category of Object.keys(
          data,
        ) as Array<keyof SignalDataTypeMap>) {
          const records = data[category] as
            | Record<string, unknown>
            | undefined;
          if (!records) continue;
          for (const [id, value] of Object.entries(records)) {
            mutations.push({
              type: category,
              id,
              serialized:
                value === null || value === undefined
                  ? null
                  : serializeBaileysValue(value),
            });
          }
        }
        if (mutations.length) await storage.applyKeyBatch(channelId, mutations);
      },
    },
  };
  return {
    state,
    saveCredentials: () =>
      storage.writeCredentials(
        channelId,
        serializeBaileysValue(credentials),
      ),
  };
}
