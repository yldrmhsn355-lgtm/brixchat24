import { createDatabase } from "../packages/database/src/index";

const KEY_FAMILIES = [
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

type SessionRow = {
  channel_id: string;
  public_id: string;
  status: string | null;
  has_credentials: boolean;
  has_qr: boolean;
  qr_expires_at: Date | string | null;
  assigned_worker_id: string | null;
  lease_expires_at: Date | string | null;
  last_heartbeat_at: Date | string | null;
  last_connected_at: Date | string | null;
  last_error_code: string | null;
};

type KeyCountRow = {
  key_type: string;
  count: number;
};

function requireValue(name: string, value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function asDate(value: Date | string | null): Date | null {
  if (!value) return null;
  return value instanceof Date ? value : new Date(value);
}

function iso(value: Date | string | null): string | null {
  return asDate(value)?.toISOString() ?? null;
}

async function main() {
  const databaseUrl = requireValue(
    "DATABASE_URL",
    process.env.DATABASE_URL,
  );
  const selector = requireValue(
    "WHATSAPP_WEB_CHANNEL_ID or first argument",
    process.env.WHATSAPP_WEB_CHANNEL_ID ?? process.argv[2],
  );
  const { client } = createDatabase(databaseUrl);

  try {
    const relations = await client<
      Array<{ sessions: string | null; keys: string | null }>
    >`
      SELECT
        to_regclass('public.whatsapp_web_sessions')::text sessions,
        to_regclass('public.whatsapp_web_signal_keys')::text keys`;
    if (!relations[0]?.sessions || !relations[0]?.keys)
      throw new Error(
        "WhatsApp Web tables are missing; apply migration 0015 only after the backup gate",
      );

    const sessions = await client<Array<SessionRow>>`
      SELECT
        c.id::text channel_id,
        c.public_id,
        s.status,
        (s.encrypted_credentials IS NOT NULL) has_credentials,
        (s.encrypted_qr IS NOT NULL) has_qr,
        s.qr_expires_at,
        s.assigned_worker_id,
        s.lease_expires_at,
        s.last_heartbeat_at,
        s.last_connected_at,
        s.last_error_code
      FROM channels c
      LEFT JOIN whatsapp_web_sessions s
        ON s.channel_id=c.id
       AND s.organization_id=c.organization_id
      WHERE c.deleted_at IS NULL
        AND c.provider='whatsapp_web'
        AND (c.id::text=${selector} OR c.public_id=${selector})
      LIMIT 2`;
    if (sessions.length !== 1)
      throw new Error(
        sessions.length === 0
          ? "No active WhatsApp Web channel matches the selector"
          : "Selector matched more than one active WhatsApp Web channel",
      );

    const session = sessions[0]!;
    const counts = await client<Array<KeyCountRow>>`
      SELECT key_type,count(*)::integer count
      FROM whatsapp_web_signal_keys
      WHERE channel_id=${session.channel_id}::uuid
      GROUP BY key_type
      ORDER BY key_type`;
    const countMap = new Map(
      counts.map((row) => [row.key_type, Number(row.count)]),
    );
    const now = Date.now();
    const leaseExpiresAt = asDate(session.lease_expires_at);
    const leaseActive =
      leaseExpiresAt !== null && leaseExpiresAt.getTime() > now;

    console.log(
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          channel: {
            id: session.channel_id,
            publicId: session.public_id,
          },
          session: {
            status: session.status,
            hasCredentials: session.has_credentials,
            hasQr: session.has_qr,
            qrExpiresAt: iso(session.qr_expires_at),
            assignedWorkerId: session.assigned_worker_id,
            leaseExpiresAt: iso(session.lease_expires_at),
            leaseActive,
            lastHeartbeatAt: iso(session.last_heartbeat_at),
            lastConnectedAt: iso(session.last_connected_at),
            lastErrorCode: session.last_error_code,
          },
          keyCounts: Object.fromEntries(
            KEY_FAMILIES.map((family) => [
              family,
              countMap.get(family) ?? 0,
            ]),
          ),
          unknownKeyCounts: Object.fromEntries(
            counts
              .filter(
                (row) =>
                  !KEY_FAMILIES.includes(
                    row.key_type as (typeof KEY_FAMILIES)[number],
                  ),
              )
              .map((row) => [row.key_type, Number(row.count)]),
          ),
        },
        null,
        2,
      ),
    );
  } finally {
    await client.end();
  }
}

void main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : "WhatsApp Web preflight failed",
  );
  process.exitCode = 1;
});
