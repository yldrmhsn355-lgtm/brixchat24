import { createHmac } from "node:crypto";
import {
  META_WHATSAPP_UNSUBSCRIBED_FIELDS,
  META_WHATSAPP_WEBHOOK_FIELDS,
} from "@brixchat/integrations";

async function postWebhook(input: {
  base: string;
  channel: string;
  secret: string;
  field: string;
  value: Record<string, unknown>;
}) {
  const payload = {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "local-business-account",
        changes: [{ field: input.field, value: input.value }],
      },
    ],
  };
  const raw = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", input.secret).update(raw).digest("hex")}`;
  const response = await fetch(
    `${input.base}/webhooks/meta/whatsapp/${input.channel}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signature,
      },
      body: raw,
    },
  );
  const body = await response.text();
  process.stdout.write(`${input.field}: ${response.status} ${body}\n`);
  if (!response.ok) process.exitCode = 1;
}

async function main() {
  const mode = process.argv[2] ?? "incoming";
  const base = process.env.API_URL ?? "http://localhost:4400";
  const channel =
    process.env.SIMULATOR_CHANNEL_PUBLIC_ID ??
    "00000000-0000-4000-8000-000000000022";
  const secret = process.env.META_WHATSAPP_APP_SECRET ?? "local-app-secret";
  const timestamp =
    process.env.SIMULATOR_TIMESTAMP ?? Math.floor(Date.now() / 1000).toString();
  const providerMessageId =
    process.env.SIMULATOR_PROVIDER_MESSAGE_ID ?? `sim_${Date.now()}`;
  const phone = (process.env.SIMULATOR_PHONE ?? "447700900999").replace(
    /\D/g,
    "",
  );
  if (mode === "fields" || mode === "unsubscribed-fields") {
    const fields =
      mode === "fields"
        ? META_WHATSAPP_WEBHOOK_FIELDS
        : META_WHATSAPP_UNSUBSCRIBED_FIELDS;
    for (const field of fields) {
      await postWebhook({
        base,
        channel,
        secret,
        field,
        value: {
          event: "local_test",
          field,
          timestamp,
        },
      });
    }
    return;
  }
  const value =
    mode === "status"
      ? {
          statuses: [
            {
              id: providerMessageId,
              status: process.env.SIMULATOR_STATUS ?? "delivered",
              timestamp,
            },
          ],
        }
      : {
          contacts: [
            {
              wa_id: phone,
              profile: {
                name: process.env.SIMULATOR_NAME ?? "Webhook Patient",
              },
            },
          ],
          messages: [
            {
              from: phone,
              id: providerMessageId,
              timestamp,
              type: "text",
              text: {
                body:
                  process.env.SIMULATOR_TEXT ??
                  "Hello from the signed webhook simulator",
              },
            },
          ],
        };
  await postWebhook({
    base,
    channel,
    secret,
    field: "messages",
    value,
  });
}

void main();
