import postgres from "postgres";

const apply = process.argv.includes("--apply");
const verify = process.argv.includes("--verify");
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL_REQUIRED");

type GroupRow = {
  organization_id: string;
  channel_id: string;
  chat_id: string;
  chat_name: string | null;
  message_count: number;
  conversation_count: number;
};

class RepairVerificationRollback extends Error {
  constructor(readonly result: { moved: number; canonicalized: number }) {
    super("WHATSAPP_WEB_GROUP_REPAIR_VERIFIED_ROLLBACK");
  }
}

async function main() {
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const groups = await sql<Array<GroupRow>>`
      SELECT
        m.organization_id,
        m.channel_id,
        m.metadata->>'chatId' chat_id,
        (
          array_agg(
            NULLIF(BTRIM(m.metadata->>'chatName'),'')
            ORDER BY COALESCE(m.provider_timestamp,m.sent_at) DESC
          ) FILTER (
            WHERE NULLIF(BTRIM(m.metadata->>'chatName'),'') IS NOT NULL
          )
        )[1] chat_name,
        count(*)::int message_count,
        count(DISTINCT m.conversation_id)::int conversation_count
      FROM messages m
      JOIN channels ch
        ON ch.id=m.channel_id
       AND ch.organization_id=m.organization_id
      WHERE ch.provider='whatsapp_web'
        AND m.metadata->>'isGroup'='true'
        AND m.metadata->>'chatId' LIKE '%@g.us'
      GROUP BY m.organization_id,m.channel_id,m.metadata->>'chatId'
      ORDER BY m.organization_id,m.channel_id,m.metadata->>'chatId'
    `;

    if (!apply && !verify) {
      console.log(
        JSON.stringify({
          mode: "dry-run",
          groups: groups.length,
          messages: groups.reduce((sum, row) => sum + row.message_count, 0),
          conversations: groups.reduce(
            (sum, row) => sum + row.conversation_count,
            0,
          ),
        }),
      );
      return;
    }

    let movedMessages = 0;
    let canonicalizedConversations = 0;
    for (const group of groups) {
      let result: { moved: number; canonicalized: number };
      try {
        result = await sql.begin(async (tx) => {
          const digits = group.chat_id.split("@")[0]?.replace(/\D/g, "") ?? "";
          if (!digits) throw new Error("WHATSAPP_WEB_GROUP_JID_INVALID");
          const phone = `+${digits}`;
          const name = group.chat_name?.trim() || "Grup adı alınıyor…";
          const contact = (
            await tx<Array<{ id: string }>>`
            INSERT INTO contacts(
              organization_id,first_name,display_name,normalized_phone,custom_fields
            )
            VALUES(
              ${group.organization_id}::uuid,
              ${name.split(" ")[0] ?? name},
              ${name},
              ${phone},
              ${tx.json({
                whatsappWebChatId: group.chat_id,
                whatsappWebConversationType: "group",
              } as never)}
            )
            ON CONFLICT(organization_id,normalized_phone)
            DO UPDATE SET
              first_name=EXCLUDED.first_name,
              display_name=EXCLUDED.display_name,
              custom_fields=contacts.custom_fields||EXCLUDED.custom_fields,
              updated_at=now()
            RETURNING id
          `
          )[0]!;

          const source = await tx<Array<{ id: string; unread_count: number }>>`
          SELECT c.id,c.unread_count
          FROM conversations c
          WHERE c.organization_id=${group.organization_id}::uuid
            AND EXISTS (
              SELECT 1
              FROM messages m
              WHERE m.organization_id=c.organization_id
                AND m.conversation_id=c.id
                AND m.channel_id=${group.channel_id}::uuid
                AND m.metadata->>'isGroup'='true'
                AND m.metadata->>'chatId'=${group.chat_id}
            )
          FOR UPDATE OF c
        `;
          const sourceIds = source.map((row) => row.id);
          const unreadCount = source.reduce(
            (sum, row) => sum + Number(row.unread_count),
            0,
          );
          let target = (
            await tx<Array<{ id: string }>>`
            SELECT c.id
            FROM conversations c
            WHERE c.organization_id=${group.organization_id}::uuid
              AND c.channel_id=${group.channel_id}::uuid
              AND c.contact_id=${contact.id}::uuid
              AND NOT EXISTS (
                SELECT 1
                FROM conversation_operation_history h
                WHERE h.organization_id=c.organization_id
                  AND h.conversation_id=c.id
                  AND h.operation='conversation.canonicalized'
              )
            ORDER BY
              CASE c.status WHEN 'open' THEN 0 WHEN 'waiting' THEN 1 ELSE 2 END,
              c.created_at DESC
            LIMIT 1
            FOR UPDATE
          `
          )[0];
          if (!target) {
            target = (
              await tx<Array<{ id: string }>>`
              INSERT INTO conversations(
                organization_id,channel_id,contact_id,status,
                customer_service_window_expires_at
              )
              SELECT
                ${group.organization_id}::uuid,
                ${group.channel_id}::uuid,
                ${contact.id}::uuid,
                'open',
                max(COALESCE(provider_timestamp,sent_at))+interval '24 hours'
              FROM messages
              WHERE organization_id=${group.organization_id}::uuid
                AND channel_id=${group.channel_id}::uuid
                AND metadata->>'isGroup'='true'
                AND metadata->>'chatId'=${group.chat_id}
              RETURNING id
            `
            )[0]!;
          }

          const moved = await tx<Array<{ id: string }>>`
          UPDATE messages
          SET conversation_id=${target.id}::uuid,
              contact_id=${contact.id}::uuid,
              updated_at=now()
          WHERE organization_id=${group.organization_id}::uuid
            AND channel_id=${group.channel_id}::uuid
            AND metadata->>'isGroup'='true'
            AND metadata->>'chatId'=${group.chat_id}
            AND (
              conversation_id<>${target.id}::uuid
              OR contact_id<>${contact.id}::uuid
            )
          RETURNING id
        `;
          await tx`
          UPDATE bitrix_open_channel_jobs j
          SET conversation_id=${target.id}::uuid,updated_at=now()
          FROM messages m
          WHERE m.id=j.local_message_id
            AND m.organization_id=${group.organization_id}::uuid
            AND m.conversation_id=${target.id}::uuid
            AND j.status IN('pending','retry')
        `;

          let canonicalized = 0;
          for (const sourceId of sourceIds) {
            if (sourceId === target.id) continue;
            const remaining = (
              await tx<
                Array<{
                  id: string | null;
                  occurred_at: string | null;
                  inbound_count: number;
                }>
              >`
              SELECT
                latest.id,
                latest.occurred_at,
                (
                  SELECT count(*)::int
                  FROM messages remaining_message
                  WHERE remaining_message.organization_id=${group.organization_id}::uuid
                    AND remaining_message.conversation_id=${sourceId}::uuid
                    AND remaining_message.direction='inbound'
                ) inbound_count
              FROM (VALUES(1)) seed(value)
              LEFT JOIN LATERAL (
                SELECT
                  id,
                  COALESCE(provider_timestamp,sent_at) occurred_at
                FROM messages
                WHERE organization_id=${group.organization_id}::uuid
                  AND conversation_id=${sourceId}::uuid
                  AND type<>'reaction'
                ORDER BY COALESCE(provider_timestamp,sent_at) DESC,id DESC
                LIMIT 1
              ) latest ON true
            `
            )[0]!;
            if (!remaining.id) {
              await tx`
              UPDATE conversations
              SET status='archived',last_message_id=NULL,unread_count=0,
                  updated_at=now()
              WHERE organization_id=${group.organization_id}::uuid
                AND id=${sourceId}::uuid
            `;
              await tx`
              INSERT INTO conversation_operation_history(
                organization_id,conversation_id,operation,from_value,to_value,origin
              )
              SELECT
                ${group.organization_id}::uuid,
                ${sourceId}::uuid,
                'conversation.canonicalized',
                ${tx.json({ reason: "whatsapp_web_group_repair" } as never)},
                ${tx.json({ conversationId: target.id } as never)},
                'system'
              WHERE NOT EXISTS (
                SELECT 1
                FROM conversation_operation_history
                WHERE organization_id=${group.organization_id}::uuid
                  AND conversation_id=${sourceId}::uuid
                  AND operation='conversation.canonicalized'
              )
            `;
              canonicalized += 1;
            } else {
              await tx`
              UPDATE conversations
              SET last_message_id=${remaining.id}::uuid,
                  last_message_at=${remaining.occurred_at}::timestamptz,
                  unread_count=LEAST(unread_count,${remaining.inbound_count}),
                  updated_at=now()
              WHERE organization_id=${group.organization_id}::uuid
                AND id=${sourceId}::uuid
            `;
            }
          }

          await tx`
          WITH aggregate AS (
            SELECT
              latest.id last_message_id,
              latest.occurred_at last_message_at,
              count(*) FILTER (WHERE m.direction='inbound')::int inbound_count
            FROM messages m
            CROSS JOIN LATERAL (
              SELECT
                id,
                COALESCE(provider_timestamp,sent_at) occurred_at
              FROM messages
              WHERE organization_id=${group.organization_id}::uuid
                AND conversation_id=${target.id}::uuid
                AND type<>'reaction'
              ORDER BY COALESCE(provider_timestamp,sent_at) DESC,id DESC
              LIMIT 1
            ) latest
            WHERE m.organization_id=${group.organization_id}::uuid
              AND m.conversation_id=${target.id}::uuid
            GROUP BY latest.id,latest.occurred_at
          )
          UPDATE conversations c
          SET status='open',
              closed_at=NULL,
              last_message_id=aggregate.last_message_id,
              last_message_at=aggregate.last_message_at,
              unread_count=LEAST(aggregate.inbound_count,${unreadCount}),
              customer_service_window_expires_at=GREATEST(
                COALESCE(c.customer_service_window_expires_at,'-infinity'::timestamptz),
                aggregate.last_message_at+interval '24 hours'
              ),
              updated_at=now()
          FROM aggregate
          WHERE c.organization_id=${group.organization_id}::uuid
            AND c.id=${target.id}::uuid
        `;
          const repairResult = { moved: moved.length, canonicalized };
          if (verify) throw new RepairVerificationRollback(repairResult);
          return repairResult;
        });
      } catch (error) {
        if (!(error instanceof RepairVerificationRollback)) throw error;
        result = error.result;
      }
      movedMessages += result.moved;
      canonicalizedConversations += result.canonicalized;
    }

    console.log(
      JSON.stringify({
        mode: verify ? "verify-rollback" : "apply",
        groups: groups.length,
        movedMessages,
        canonicalizedConversations,
      }),
    );
  } finally {
    await sql.end();
  }
}

void main();
