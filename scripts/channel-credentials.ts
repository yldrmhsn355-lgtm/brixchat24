import postgres from "postgres";
import {
  encryptSecret,
  hashSecret,
} from "../packages/integrations/src/messaging/utils";

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  const encryptionKey = process.env.APP_ENCRYPTION_KEY;
  const channelId = process.env.CHANNEL_ID;
  const accessToken = process.env.META_WHATSAPP_ACCESS_TOKEN;
  const appSecret = process.env.META_WHATSAPP_APP_SECRET;
  const verifyToken = process.env.META_WHATSAPP_VERIFY_TOKEN;
  if (
    !databaseUrl ||
    !encryptionKey ||
    !channelId ||
    !accessToken ||
    !appSecret ||
    !verifyToken
  ) {
    throw new Error(
      "DATABASE_URL, APP_ENCRYPTION_KEY, CHANNEL_ID and Meta credential environment variables are required",
    );
  }
  const encrypted = encryptSecret(
    JSON.stringify({ accessToken, appSecret }),
    encryptionKey,
  );
  const sql = postgres(databaseUrl);
  try {
    const rows = await sql`
      UPDATE channels
      SET credentials_encrypted=${encrypted}, verify_token_hash=${hashSecret(verifyToken)}, provider='meta_whatsapp_cloud', updated_at=now()
      WHERE id=${channelId}::uuid
      RETURNING id
    `;
    if (rows.length !== 1) throw new Error("Channel not found");
    process.stdout.write("Channel credentials encrypted and stored.\n");
  } finally {
    await sql.end();
  }
}

void main();
