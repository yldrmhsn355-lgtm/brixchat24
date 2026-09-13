import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AuthClaims, Permission } from "@brixchat/auth";
import {
  ConversationLabelRepository,
  ConversationRepository,
} from "@brixchat/database";
import type { DatabaseClient } from "@brixchat/database";
import { z } from "zod";

type Authorize = (
  permission: Permission,
) => (request: FastifyRequest) => Promise<void>;
type Publish = (
  organizationId: string,
  event: Record<string, unknown>,
) => Promise<void>;
interface Options {
  authorize: Authorize;
  publish: Publish;
  runWithTenant?: <T>(
    organizationId: string,
    callback: () => Promise<T>,
  ) => Promise<T>;
}
type Row = Record<string, unknown>;
const operationSchema = z
  .object({
    status: z
      .enum(["open", "waiting", "snoozed", "closed", "archived", "spam"])
      .optional(),
    priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
    snoozedUntil: z.string().datetime().nullable().optional(),
    pinned: z.boolean().optional(),
    mutedUntil: z.string().datetime().nullable().optional(),
    blocked: z.boolean().optional(),
  })
  .refine(
    (value) => Object.keys(value).length > 0,
    "At least one operation is required",
  )
  .refine(
    (value) => value.status !== "snoozed" || Boolean(value.snoozedUntil),
    "snoozedUntil is required",
  );
const assignSchema = z.object({
  userId: z.string().uuid().nullable().optional(),
  teamId: z.string().uuid().nullable().optional(),
  reason: z.string().trim().min(1).max(200).default("manual"),
  origin: z.enum(["manual", "rule", "bitrix24"]).default("manual"),
});
const noteSchema = z.object({
  body: z.string().trim().min(1).max(10000),
  mentionUserIds: z.array(z.string().uuid()).max(20).default([]),
  parentNoteId: z.string().uuid().optional(),
});
const viewSchema = z.object({
  name: z.string().trim().min(1).max(80),
  visibility: z.enum(["personal", "shared"]).default("personal"),
  filters: z.record(z.string(), z.unknown()).default({}),
  sort: z.record(z.string(), z.unknown()).default({}),
  position: z.number().int().min(0).default(0),
  isDefault: z.boolean().default(false),
});

const event = (
  type: string,
  organizationId: string,
  conversationId: string,
  payload: Record<string, unknown>,
) => ({
  eventId: crypto.randomUUID(),
  eventType: type,
  organizationId,
  entityType: "conversation",
  entityId: conversationId,
  conversationId,
  occurredAt: new Date().toISOString(),
  payloadVersion: 1,
  payload,
});
async function exists(
  sql: DatabaseClient,
  organizationId: string,
  conversationId: string,
) {
  return (
    (
      await sql`SELECT id FROM conversations WHERE id=${conversationId}::uuid AND organization_id=${organizationId}::uuid`
    ).length === 1
  );
}

export function registerConversationOpsRoutes(
  app: FastifyInstance,
  sql: DatabaseClient,
  options: Options,
) {
  const conversations = new ConversationRepository(sql);
  const conversationLabels = new ConversationLabelRepository(sql);

  app.addHook("preHandler", async (request, reply) => {
    const path = request.url.split("?", 1)[0] ?? "";
    if (!path.startsWith("/api/v1/conversations/")) return;
    const claims = request.claims ?? (await request.jwtVerify<AuthClaims>());
    if (!claims || !["agent", "team_lead"].includes(claims.role)) return;
    const access = (conversationIds: string[]) => {
      const query = () =>
        conversations.hasOwnedChannelAccess({
          organizationId: claims.organizationId,
          userId: claims.sub,
          conversationIds,
        });
      return options.runWithTenant
        ? options.runWithTenant(claims.organizationId, query)
        : query();
    };
    const segment =
      path.slice("/api/v1/conversations/".length).split("/", 1)[0] ?? "";
    if (segment === "bulk") {
      const ids = Array.isArray(
        (request.body as { conversationIds?: unknown })?.conversationIds,
      )
        ? (
            request.body as { conversationIds: unknown[] }
          ).conversationIds.filter((id): id is string => typeof id === "string")
        : [];
      if (!ids.length) return;
      const accessible = await access(ids);
      if (!accessible)
        return reply.code(404).send({
          error: {
            code: "conversation_not_found",
            message: "Conversation not found",
          },
        });
      return;
    }
    if (!/^[0-9a-f-]{36}$/i.test(segment)) return;
    const accessible = await access([segment]);
    if (!accessible)
      return reply.code(404).send({
        error: {
          code: "conversation_not_found",
          message: "Conversation not found",
        },
      });
  });
  app.get(
    "/api/v1/inbox/assignees",
    { preHandler: options.authorize("conversation:assign") },
    async (request) => {
      return {
        data: await conversations.listAssignees(request.claims!.organizationId),
      };
    },
  );
  app.patch<{ Params: { id: string } }>(
    "/api/v1/conversations/:id/operations",
    { preHandler: options.authorize("conversation:operate") },
    async (request, reply) => {
      const body = operationSchema.parse(request.body),
        organizationId = request.claims!.organizationId;
      const result = await sql.begin(async (tx) => {
        const current = (
          await tx<
            Row[]
          >`SELECT * FROM conversations WHERE id=${request.params.id}::uuid AND organization_id=${organizationId}::uuid FOR UPDATE`
        )[0];
        if (!current) return null;
        const next = {
          status: body.status ?? String(current.status),
          priority: body.priority ?? String(current.priority),
          snoozedUntil:
            body.snoozedUntil === undefined
              ? current.snoozed_until
                ? String(current.snoozed_until)
                : null
              : body.snoozedUntil,
          pinnedAt:
            body.pinned === undefined
              ? current.pinned_at
                ? new Date(String(current.pinned_at))
                : null
              : body.pinned
                ? new Date()
                : null,
          mutedUntil:
            body.mutedUntil === undefined
              ? current.muted_until
                ? String(current.muted_until)
                : null
              : body.mutedUntil,
          blockedAt:
            body.blocked === undefined
              ? current.blocked_at
                ? new Date(String(current.blocked_at))
                : null
              : body.blocked
                ? new Date()
                : null,
        };
        const supersedeConversation = async (obsolete: Row, canonical: Row) => {
          const occupied = await tx<Row[]>`
            SELECT status::text status
            FROM conversations
            WHERE organization_id=${organizationId}::uuid
              AND channel_id=${String(obsolete.channel_id)}::uuid
              AND contact_id=${String(obsolete.contact_id)}::uuid
              AND id<>${String(obsolete.id)}::uuid
            FOR UPDATE`;
          const occupiedStatuses = new Set(
            occupied.map((row) => String(row.status)),
          );
          const tombstoneStatus = ["spam", "closed", "snoozed", "waiting"].find(
            (status) => !occupiedStatuses.has(status),
          );
          if (!tombstoneStatus)
            throw Object.assign(
              new Error("conversation_canonicalization_conflict"),
              { statusCode: 409 },
            );
          await tx`
            UPDATE conversations
            SET
              status=${tombstoneStatus}::conversation_status,
              operation_version=operation_version+1,
              updated_at=now()
            WHERE id=${String(obsolete.id)}::uuid
              AND organization_id=${organizationId}::uuid`;
          await tx`
            INSERT INTO conversation_operation_history(
              organization_id,
              conversation_id,
              operation,
              from_value,
              to_value,
              actor_id,
              origin
            )
            VALUES(
              ${organizationId}::uuid,
              ${String(obsolete.id)}::uuid,
              'conversation.canonicalized',
              ${tx.json({ status: obsolete.status } as never)},
              ${tx.json({
                canonicalConversationId: canonical.id,
                status: canonical.status,
                tombstoneStatus,
              } as never)},
              ${request.claims!.sub}::uuid,
              'local'
            )`;
        };
        if (String(current.status) === "archived" && next.status === "open") {
          const canonical = (
            await tx<Row[]>`
              SELECT *
              FROM conversations
              WHERE organization_id=${organizationId}::uuid
                AND channel_id=${String(current.channel_id)}::uuid
                AND contact_id=${String(current.contact_id)}::uuid
                AND id<>${request.params.id}::uuid
                AND status IN ('open','waiting')
                AND NOT EXISTS (
                  SELECT 1
                  FROM conversation_operation_history history
                  WHERE history.organization_id=conversations.organization_id
                    AND history.conversation_id=conversations.id
                    AND history.operation='conversation.canonicalized'
                )
              ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END,updated_at DESC
              LIMIT 1
              FOR UPDATE`
          )[0];
          if (canonical) {
            await supersedeConversation(current, canonical);
            return {
              ...canonical,
              canonicalConversationId: String(canonical.id),
            };
          }
        }
        if (
          String(current.status) !== "archived" &&
          next.status === "archived"
        ) {
          const duplicateArchived = (
            await tx<Row[]>`
              SELECT *
              FROM conversations
              WHERE organization_id=${organizationId}::uuid
                AND channel_id=${String(current.channel_id)}::uuid
                AND contact_id=${String(current.contact_id)}::uuid
                AND id<>${request.params.id}::uuid
                AND status='archived'
              ORDER BY updated_at DESC
              LIMIT 1
              FOR UPDATE`
          )[0];
          if (duplicateArchived)
            await supersedeConversation(duplicateArchived, current);
        }
        const rows = await tx<
          Row[]
        >`UPDATE conversations SET status=${next.status}::conversation_status,priority=${next.priority},snoozed_until=${next.snoozedUntil}::timestamptz,pinned_at=${next.pinnedAt},muted_until=${next.mutedUntil}::timestamptz,blocked_at=${next.blockedAt},closed_at=CASE WHEN ${next.status}='closed' THEN COALESCE(closed_at,now()) WHEN ${next.status}='open' THEN NULL ELSE closed_at END,operation_version=operation_version+1,updated_at=now() WHERE id=${request.params.id}::uuid AND organization_id=${organizationId}::uuid RETURNING *`;
        if (current.assignee_id && current.status !== next.status) {
          if (
            next.status === "closed" &&
            ["open", "waiting", "snoozed"].includes(String(current.status))
          )
            await tx`UPDATE agent_capacity_status SET active_count=GREATEST(active_count-1,0),updated_at=now() WHERE organization_id=${organizationId}::uuid AND user_id=${String(current.assignee_id)}::uuid`;
          if (
            String(current.status) === "closed" &&
            ["open", "waiting", "snoozed"].includes(next.status)
          )
            await tx`INSERT INTO agent_capacity_status(organization_id,user_id,active_count,last_assigned_at) VALUES(${organizationId}::uuid,${String(current.assignee_id)}::uuid,1,now()) ON CONFLICT(organization_id,user_id) DO UPDATE SET active_count=agent_capacity_status.active_count+1,updated_at=now()`;
        }
        await tx`INSERT INTO conversation_operation_history(organization_id,conversation_id,operation,from_value,to_value,actor_id,origin) VALUES(${organizationId}::uuid,${request.params.id}::uuid,'conversation.update',${tx.json({ status: current.status, priority: current.priority, snoozedUntil: current.snoozed_until, pinnedAt: current.pinned_at, mutedUntil: current.muted_until, blockedAt: current.blocked_at } as never)},${tx.json(next as never)},${request.claims!.sub}::uuid,'local')`;
        return rows[0];
      });
      if (!result)
        return reply.code(404).send({
          error: {
            code: "conversation_not_found",
            message: "Conversation not found",
          },
        });
      await options.publish(
        organizationId,
        event("conversation.updated", organizationId, String(result.id), {
          conversation: result,
        }),
      );
      return { data: result };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/v1/conversations/:id/assign",
    { preHandler: options.authorize("conversation:assign") },
    async (request, reply) => {
      const body = assignSchema.parse(request.body),
        organizationId = request.claims!.organizationId;
      const userId = body.userId ?? null;
      const teamId = body.teamId ?? null;
      const result = await sql.begin(async (tx) => {
        const current = (
          await tx<
            Row[]
          >`SELECT assignee_id,team_id,operation_version FROM conversations WHERE id=${request.params.id}::uuid AND organization_id=${organizationId}::uuid FOR UPDATE`
        )[0];
        if (!current) return null;
        if (
          userId &&
          !(
            await tx`SELECT 1 FROM organization_members om JOIN users u ON u.id=om.user_id WHERE om.organization_id=${organizationId}::uuid AND om.user_id=${userId}::uuid AND om.role IN ('owner','admin','team_lead','agent') AND u.is_active=true AND u.suspended_at IS NULL`
          ).length
        )
          throw Object.assign(new Error("assignee_not_available"), {
            statusCode: 422,
          });
        if (
          teamId &&
          !(
            await tx`SELECT 1 FROM teams WHERE organization_id=${organizationId}::uuid AND id=${teamId}::uuid`
          ).length
        )
          throw Object.assign(new Error("team_not_found"), { statusCode: 422 });
        const version = Number(current.operation_version) + 1;
        await tx`UPDATE conversation_assignments SET active=false,unassigned_by=${request.claims!.sub}::uuid,unassigned_at=now() WHERE conversation_id=${request.params.id}::uuid AND active`;
        if (
          current.assignee_id &&
          String(current.assignee_id) !== String(userId ?? "")
        )
          await tx`UPDATE agent_capacity_status SET active_count=GREATEST(active_count-1,0),updated_at=now() WHERE organization_id=${organizationId}::uuid AND user_id=${String(current.assignee_id)}::uuid`;
        if (userId || teamId)
          await tx`INSERT INTO conversation_assignments(organization_id,conversation_id,user_id,team_id,origin,version,assigned_by) VALUES(${organizationId}::uuid,${request.params.id}::uuid,${userId}::uuid,${teamId}::uuid,${body.origin},${version},${request.claims!.sub}::uuid)`;
        if (userId && String(current.assignee_id ?? "") !== String(userId))
          await tx`INSERT INTO agent_capacity_status(organization_id,user_id,active_count,last_assigned_at) VALUES(${organizationId}::uuid,${userId}::uuid,1,now()) ON CONFLICT(organization_id,user_id) DO UPDATE SET active_count=agent_capacity_status.active_count+1,last_assigned_at=now(),updated_at=now()`;
        const rows = await tx<
          Row[]
        >`UPDATE conversations SET assignee_id=${userId}::uuid,team_id=${teamId}::uuid,operation_version=${version},updated_at=now() WHERE id=${request.params.id}::uuid AND organization_id=${organizationId}::uuid RETURNING id,assignee_id,team_id,operation_version`;
        await tx`INSERT INTO assignment_history(organization_id,conversation_id,from_user_id,to_user_id,from_team_id,to_team_id,reason,origin,version,actor_id) VALUES(${organizationId}::uuid,${request.params.id}::uuid,${current.assignee_id ? String(current.assignee_id) : null}::uuid,${userId}::uuid,${current.team_id ? String(current.team_id) : null}::uuid,${teamId}::uuid,${body.reason},${body.origin},${version},${request.claims!.sub}::uuid)`;
        const connections = await tx<
          Row[]
        >`SELECT id FROM integration_connections WHERE organization_id=${organizationId}::uuid AND status='connected' AND COALESCE((settings->>'syncResponsible')::boolean,false)=true ORDER BY created_at LIMIT 1`;
        if (connections[0])
          await tx`INSERT INTO crm_sync_jobs(organization_id,connection_id,job_type,aggregate_type,aggregate_id,idempotency_key,payload) VALUES(${organizationId}::uuid,${String(connections[0].id)}::uuid,'responsible.sync','conversation',${request.params.id},${`assignment:${request.params.id}:${version}`},${tx.json({ conversationId: request.params.id, userId, origin: "brixchat", version } as never)}) ON CONFLICT(connection_id,idempotency_key) DO NOTHING`;
        return rows[0];
      });
      if (!result)
        return reply.code(404).send({
          error: {
            code: "conversation_not_found",
            message: "Conversation not found",
          },
        });
      await options.publish(
        organizationId,
        event("conversation.assigned", organizationId, request.params.id, {
          assignment: result,
        }),
      );
      return { data: result };
    },
  );
  app.delete<{ Params: { id: string } }>(
    "/api/v1/conversations/:id/assign",
    { preHandler: options.authorize("conversation:assign") },
    async (request, reply) => {
      const organizationId = request.claims!.organizationId;
      const rows = await sql.begin(async (tx) => {
        const current = (
          await tx<
            Row[]
          >`SELECT assignee_id,team_id,operation_version FROM conversations WHERE id=${request.params.id}::uuid AND organization_id=${organizationId}::uuid FOR UPDATE`
        )[0];
        if (!current) return [];
        const version = Number(current.operation_version) + 1;
        await tx`UPDATE conversation_assignments SET active=false,unassigned_by=${request.claims!.sub}::uuid,unassigned_at=now() WHERE conversation_id=${request.params.id}::uuid AND active`;
        if (current.assignee_id)
          await tx`UPDATE agent_capacity_status SET active_count=GREATEST(active_count-1,0),updated_at=now() WHERE organization_id=${organizationId}::uuid AND user_id=${String(current.assignee_id)}::uuid`;
        await tx`INSERT INTO assignment_history(organization_id,conversation_id,from_user_id,from_team_id,reason,origin,version,actor_id) VALUES(${organizationId}::uuid,${request.params.id}::uuid,${current.assignee_id ? String(current.assignee_id) : null}::uuid,${current.team_id ? String(current.team_id) : null}::uuid,'unassigned','manual',${version},${request.claims!.sub}::uuid)`;
        return tx<
          Row[]
        >`UPDATE conversations SET assignee_id=NULL,team_id=NULL,operation_version=${version},updated_at=now() WHERE id=${request.params.id}::uuid AND organization_id=${organizationId}::uuid RETURNING id,operation_version`;
      });
      if (!rows[0])
        return reply.code(404).send({
          error: {
            code: "conversation_not_found",
            message: "Conversation not found",
          },
        });
      await options.publish(
        organizationId,
        event("conversation.assigned", organizationId, request.params.id, {
          assignment: rows[0],
        }),
      );
      return { data: rows[0] };
    },
  );

  app.post<{ Params: { id: string; labelId: string } }>(
    "/api/v1/conversations/:id/labels/:labelId",
    { preHandler: options.authorize("labels:assign") },
    async (request, reply) => {
      const organizationId = request.claims!.organizationId;
      const correlationId = crypto.randomUUID();
      const result = await sql.begin(async (tx) => {
        const label = (
          await tx<Row[]>`
            SELECT l.*,lc.selection_mode,c.channel_id,c.team_id
            FROM conversation_labels l
            JOIN conversations c
              ON c.id=${request.params.id}::uuid
              AND c.organization_id=l.organization_id
            LEFT JOIN label_categories lc ON lc.id=l.category_id
            WHERE l.id=${request.params.labelId}::uuid
              AND l.organization_id=${organizationId}::uuid
              AND l.status='active' AND l.deleted_at IS NULL
              AND (
                l.scope='workspace'
                OR l.scope='team' AND (
                  ${["owner", "admin"].includes(request.claims!.role)}
                  OR EXISTS(
                    SELECT 1 FROM team_members tm
                    WHERE tm.organization_id=l.organization_id
                      AND tm.team_id=l.team_id
                      AND tm.user_id=${request.claims!.sub}::uuid
                  )
                )
                OR l.scope='channel'
                  AND l.channel_id=c.channel_id
                  AND (
                    ${["owner", "admin"].includes(request.claims!.role)}
                    OR EXISTS(
                      SELECT 1 FROM channel_user_ownership cuo
                      WHERE cuo.organization_id=l.organization_id
                        AND cuo.channel_id=l.channel_id
                        AND cuo.user_id=${request.claims!.sub}::uuid
                    )
                  )
              )
            FOR UPDATE OF l,c`
        )[0];
        if (!label) return null;
        let replaced: Row[] = [];
        if (label.category_id && label.selection_mode === "single")
          replaced = await tx<Row[]>`
            DELETE FROM conversation_label_assignments a
            USING conversation_labels existing
            WHERE a.organization_id=${organizationId}::uuid
              AND a.conversation_id=${request.params.id}::uuid
              AND a.label_id=existing.id
              AND existing.category_id=${String(label.category_id)}::uuid
              AND existing.id<>${request.params.labelId}::uuid
            RETURNING a.label_id`;
        const inserted = await tx<Row[]>`
          INSERT INTO conversation_label_assignments(
            organization_id,conversation_id,label_id,assigned_by,source,
            assigned_at,correlation_id
          ) VALUES(
            ${organizationId}::uuid,${request.params.id}::uuid,
            ${request.params.labelId}::uuid,${request.claims!.sub}::uuid,
            'manual',now(),${correlationId}::uuid
          )
          ON CONFLICT(conversation_id,label_id) DO NOTHING
          RETURNING *`;
        for (const item of replaced)
          await tx`INSERT INTO label_usage_events(
            organization_id,label_id,conversation_id,actor_id,event_type,
            source,correlation_id,metadata
          ) VALUES(
            ${organizationId}::uuid,${String(item.label_id)}::uuid,
            ${request.params.id}::uuid,${request.claims!.sub}::uuid,
            'replaced','manual',${correlationId}::uuid,
            ${tx.json({ replacementLabelId: request.params.labelId } as never)}
          )`;
        if (inserted[0]) {
          await tx`INSERT INTO label_usage_events(
            organization_id,label_id,conversation_id,actor_id,event_type,
            source,correlation_id
          ) VALUES(
            ${organizationId}::uuid,${request.params.labelId}::uuid,
            ${request.params.id}::uuid,${request.claims!.sub}::uuid,
            'assigned','manual',${correlationId}::uuid
          )`;
          await tx`INSERT INTO automation_events(
            organization_id,event_type,aggregate_type,aggregate_id,
            conversation_id,correlation_id,origin,payload
          ) VALUES(
            ${organizationId}::uuid,'label_added','conversation',
            ${request.params.id}::uuid,${request.params.id}::uuid,
            ${correlationId}::uuid,'manual',
            ${tx.json({ labelId: request.params.labelId, source: "manual" } as never)}
          ) ON CONFLICT DO NOTHING`;
        }
        await tx`INSERT INTO audit_logs(
          organization_id,actor_id,action,entity_type,entity_id,metadata
        ) VALUES(
          ${organizationId}::uuid,${request.claims!.sub}::uuid,
          ${replaced.length ? "conversation.label_replaced" : "conversation.label_added"},
          'conversation',${request.params.id}::uuid,
          ${tx.json({
            labelId: request.params.labelId,
            replacedLabelIds: replaced.map((item) => item.label_id),
            correlationId,
          } as never)}
        )`;
        return { assignment: inserted[0] ?? null, replaced };
      });
      if (!result)
        return reply.code(404).send({
          error: {
            code: "label_or_conversation_not_found",
            message: "Etiket veya konuşma bulunamadı.",
          },
        });
      await options.publish(
        organizationId,
        event(
          result.replaced.length
            ? "conversation.label_replaced"
            : "conversation.label_added",
          organizationId,
          request.params.id,
          {
            labelId: request.params.labelId,
            replacedLabelIds: result.replaced.map((item) => item.label_id),
            correlationId,
          },
        ),
      );
      return reply.code(result.assignment ? 201 : 200).send({
        data: {
          assignment: result.assignment,
          replacedLabelIds: result.replaced.map((item) => item.label_id),
        },
      });
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/v1/conversations/:id/labels",
    { preHandler: options.authorize("inbox:read") },
    async (request) => ({
      data: await conversationLabels.listForConversation(
        request.claims!.organizationId,
        request.params.id,
      ),
    }),
  );
  app.delete<{ Params: { id: string; labelId: string } }>(
    "/api/v1/conversations/:id/labels/:labelId",
    { preHandler: options.authorize("labels:assign") },
    async (request, reply) => {
      const correlationId = crypto.randomUUID();
      const rows = await sql.begin(async (tx) => {
        const removed = await tx<Row[]>`
          DELETE FROM conversation_label_assignments
          WHERE organization_id=${request.claims!.organizationId}::uuid
            AND conversation_id=${request.params.id}::uuid
            AND label_id=${request.params.labelId}::uuid
          RETURNING *`;
        if (!removed[0]) return removed;
        await tx`INSERT INTO label_usage_events(
          organization_id,label_id,conversation_id,actor_id,event_type,
          source,correlation_id
        ) VALUES(
          ${request.claims!.organizationId}::uuid,
          ${request.params.labelId}::uuid,${request.params.id}::uuid,
          ${request.claims!.sub}::uuid,'removed','manual',${correlationId}::uuid
        )`;
        await tx`INSERT INTO automation_events(
          organization_id,event_type,aggregate_type,aggregate_id,
          conversation_id,correlation_id,origin,payload
        ) VALUES(
          ${request.claims!.organizationId}::uuid,'label_removed','conversation',
          ${request.params.id}::uuid,${request.params.id}::uuid,
          ${correlationId}::uuid,'manual',
          ${tx.json({ labelId: request.params.labelId, source: "manual" } as never)}
        ) ON CONFLICT DO NOTHING`;
        await tx`INSERT INTO audit_logs(
          organization_id,actor_id,action,entity_type,entity_id,metadata
        ) VALUES(
          ${request.claims!.organizationId}::uuid,${request.claims!.sub}::uuid,
          'conversation.label_removed','conversation',${request.params.id}::uuid,
          ${tx.json({ labelId: request.params.labelId, correlationId } as never)}
        )`;
        return removed;
      });
      if (rows[0])
        await options.publish(
          request.claims!.organizationId,
          event(
            "conversation.label_removed",
            request.claims!.organizationId,
            request.params.id,
            { labelId: request.params.labelId, correlationId },
          ),
        );
      return reply.code(204).send();
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/v1/conversations/:id/notes",
    { preHandler: options.authorize("conversation:notes") },
    async (request, reply) => {
      if (
        !(await exists(sql, request.claims!.organizationId, request.params.id))
      )
        return reply.code(404).send({
          error: {
            code: "conversation_not_found",
            message: "Conversation not found",
          },
        });
      return {
        data: await sql`SELECT n.id,n.parent_note_id,n.body,n.edited_at,n.deleted_at,n.created_at,n.updated_at,u.full_name author_name,u.id author_id,COALESCE(json_agg(json_build_object('id',mu.id,'name',mu.full_name)) FILTER(WHERE mu.id IS NOT NULL),'[]') mentions FROM conversation_notes n JOIN users u ON u.id=n.author_id LEFT JOIN conversation_note_mentions m ON m.note_id=n.id LEFT JOIN users mu ON mu.id=m.user_id WHERE n.organization_id=${request.claims!.organizationId}::uuid AND n.conversation_id=${request.params.id}::uuid GROUP BY n.id,u.id ORDER BY n.created_at`,
      };
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/v1/conversations/:id/notes",
    { preHandler: options.authorize("conversation:notes") },
    async (request, reply) => {
      const body = noteSchema.parse(request.body),
        organizationId = request.claims!.organizationId;
      const result = await sql.begin(async (tx) => {
        if (
          !(
            await tx`SELECT id FROM conversations WHERE id=${request.params.id}::uuid AND organization_id=${organizationId}::uuid`
          ).length
        )
          return null;
        const validMentions = body.mentionUserIds.length
          ? await tx<
              Row[]
            >`SELECT om.user_id FROM organization_members om JOIN users u ON u.id=om.user_id WHERE om.organization_id=${organizationId}::uuid AND om.user_id IN ${sql(body.mentionUserIds)} AND u.is_active=true`
          : [];
        if (validMentions.length !== new Set(body.mentionUserIds).size)
          throw Object.assign(new Error("invalid_mention_target"), {
            statusCode: 422,
          });
        const rows = await tx<
          Row[]
        >`INSERT INTO conversation_notes(organization_id,conversation_id,author_id,parent_note_id,body) VALUES(${organizationId}::uuid,${request.params.id}::uuid,${request.claims!.sub}::uuid,${body.parentNoteId ?? null}::uuid,${body.body}) RETURNING *`;
        for (const mention of validMentions) {
          await tx`INSERT INTO conversation_note_mentions(note_id,organization_id,user_id) VALUES(${String(rows[0]!.id)}::uuid,${organizationId}::uuid,${String(mention.user_id)}::uuid) ON CONFLICT DO NOTHING`;
          await tx`INSERT INTO notifications(organization_id,user_id,type,title,body,metadata) VALUES(${organizationId}::uuid,${String(mention.user_id)}::uuid,'note.mentioned','Bir iç notta etiketlendiniz','Bir konuşma notunda sizden bahsedildi.',${tx.json({ conversationId: request.params.id, noteId: rows[0]!.id } as never)})`;
        }
        return { note: rows[0], mentions: validMentions };
      });
      if (!result)
        return reply.code(404).send({
          error: {
            code: "conversation_not_found",
            message: "Conversation not found",
          },
        });
      await options.publish(
        organizationId,
        event("note.created", organizationId, request.params.id, result),
      );
      for (const mention of result.mentions)
        await options.publish(organizationId, {
          ...event("notification.created", organizationId, request.params.id, {
            noteId: result.note!.id,
          }),
          userId: String(mention.user_id),
        });
      return reply.code(201).send({ data: result.note });
    },
  );
  app.patch<{ Params: { id: string } }>(
    "/api/v1/notes/:id",
    { preHandler: options.authorize("conversation:notes") },
    async (request, reply) => {
      const body = z
        .object({ body: z.string().trim().min(1).max(10000) })
        .parse(request.body);
      const rows = await sql<
        Row[]
      >`UPDATE conversation_notes SET body=${body.body},edited_at=now(),updated_at=now() WHERE id=${request.params.id}::uuid AND organization_id=${request.claims!.organizationId}::uuid AND (author_id=${request.claims!.sub}::uuid OR ${["owner", "admin"].includes(request.claims!.role)}) AND deleted_at IS NULL RETURNING *`;
      return rows[0]
        ? { data: rows[0] }
        : reply.code(404).send({
            error: { code: "note_not_found", message: "Note not found" },
          });
    },
  );
  app.delete<{ Params: { id: string } }>(
    "/api/v1/notes/:id",
    { preHandler: options.authorize("conversation:notes") },
    async (request, reply) => {
      const rows =
        await sql`UPDATE conversation_notes SET body='',deleted_at=now(),updated_at=now() WHERE id=${request.params.id}::uuid AND organization_id=${request.claims!.organizationId}::uuid AND (author_id=${request.claims!.sub}::uuid OR ${["owner", "admin"].includes(request.claims!.role)}) RETURNING id`;
      return rows.length
        ? reply.code(204).send()
        : reply.code(404).send({
            error: { code: "note_not_found", message: "Note not found" },
          });
    },
  );

  app.get(
    "/api/v1/saved-views",
    { preHandler: options.authorize("inbox:read") },
    async (request) => ({
      data: await sql`SELECT * FROM saved_views WHERE organization_id=${request.claims!.organizationId}::uuid AND (owner_user_id=${request.claims!.sub}::uuid OR visibility='shared') ORDER BY position,name`,
    }),
  );
  app.post(
    "/api/v1/saved-views",
    { preHandler: options.authorize("views:manage") },
    async (request, reply) => {
      const body = viewSchema.parse(request.body);
      const rows = await sql<
        Row[]
      >`INSERT INTO saved_views(organization_id,owner_user_id,name,visibility,filters,sort,position,is_default) VALUES(${request.claims!.organizationId}::uuid,${request.claims!.sub}::uuid,${body.name},${body.visibility},${sql.json(body.filters as never)},${sql.json(body.sort as never)},${body.position},${body.isDefault}) RETURNING *`;
      return reply.code(201).send({ data: rows[0] });
    },
  );
  app.patch<{ Params: { id: string } }>(
    "/api/v1/saved-views/:id",
    { preHandler: options.authorize("views:manage") },
    async (request, reply) => {
      const body = viewSchema.partial().parse(request.body);
      const rows = await sql<
        Row[]
      >`UPDATE saved_views SET name=COALESCE(${body.name ?? null},name),visibility=COALESCE(${body.visibility ?? null},visibility),filters=COALESCE(${body.filters ? JSON.stringify(body.filters) : null}::jsonb,filters),sort=COALESCE(${body.sort ? JSON.stringify(body.sort) : null}::jsonb,sort),position=COALESCE(${body.position ?? null},position),is_default=COALESCE(${body.isDefault ?? null},is_default),updated_at=now() WHERE id=${request.params.id}::uuid AND organization_id=${request.claims!.organizationId}::uuid AND owner_user_id=${request.claims!.sub}::uuid RETURNING *`;
      return rows[0]
        ? { data: rows[0] }
        : reply.code(404).send({
            error: {
              code: "saved_view_not_found",
              message: "Saved view not found",
            },
          });
    },
  );
  app.delete<{ Params: { id: string } }>(
    "/api/v1/saved-views/:id",
    { preHandler: options.authorize("views:manage") },
    async (request, reply) => {
      const rows =
        await sql`DELETE FROM saved_views WHERE id=${request.params.id}::uuid AND organization_id=${request.claims!.organizationId}::uuid AND owner_user_id=${request.claims!.sub}::uuid RETURNING id`;
      return rows.length
        ? reply.code(204).send()
        : reply.code(404).send({
            error: {
              code: "saved_view_not_found",
              message: "Saved view not found",
            },
          });
    },
  );

  app.post(
    "/api/v1/conversations/bulk",
    { preHandler: options.authorize("conversation:bulk") },
    async (request) => {
      const body = z
        .object({
          conversationIds: z.array(z.string().uuid()).min(1).max(100),
          action: z.enum([
            "status",
            "priority",
            "assign",
            "label",
            "pin",
            "mute",
          ]),
          value: z.unknown(),
        })
        .parse(request.body);
      const ids = [...new Set(body.conversationIds)];
      const value = body.value;
      const rows = await sql.begin(async (tx) => {
        const accessible = await tx<
          Row[]
        >`SELECT id FROM conversations WHERE organization_id=${request.claims!.organizationId}::uuid AND id IN ${sql(ids)}`;
        if (accessible.length !== ids.length)
          throw Object.assign(new Error("bulk_scope_mismatch"), {
            statusCode: 404,
          });
        if (body.action === "status") {
          const status = z
            .enum(["open", "waiting", "snoozed", "closed", "archived", "spam"])
            .parse(value);
          return tx`UPDATE conversations SET status=${status}::conversation_status,operation_version=operation_version+1,updated_at=now() WHERE organization_id=${request.claims!.organizationId}::uuid AND id IN ${sql(ids)} RETURNING id`;
        }
        if (body.action === "priority") {
          const priority = z
            .enum(["low", "normal", "high", "urgent"])
            .parse(value);
          return tx`UPDATE conversations SET priority=${priority},operation_version=operation_version+1,updated_at=now() WHERE organization_id=${request.claims!.organizationId}::uuid AND id IN ${sql(ids)} RETURNING id`;
        }
        if (body.action === "pin")
          return tx`UPDATE conversations SET pinned_at=CASE WHEN ${Boolean(value)} THEN now() ELSE NULL END,operation_version=operation_version+1,updated_at=now() WHERE organization_id=${request.claims!.organizationId}::uuid AND id IN ${sql(ids)} RETURNING id`;
        if (body.action === "mute")
          return tx`UPDATE conversations SET muted_until=${typeof value === "string" ? value : null}::timestamptz,operation_version=operation_version+1,updated_at=now() WHERE organization_id=${request.claims!.organizationId}::uuid AND id IN ${sql(ids)} RETURNING id`;
        throw Object.assign(
          new Error("bulk_action_requires_dedicated_endpoint"),
          { statusCode: 422 },
        );
      });
      for (const row of rows)
        await options.publish(
          request.claims!.organizationId,
          event(
            "conversation.updated",
            request.claims!.organizationId,
            String(row.id),
            { bulkAction: body.action },
          ),
        );
      return { data: { updated: rows.length } };
    },
  );

  app.post(
    "/api/v1/conversations/export",
    { preHandler: options.authorize("conversation:export") },
    async (request, reply) => {
      const body = z
        .object({
          format: z.enum(["csv", "json"]).default("csv"),
          status: z
            .enum(["open", "waiting", "snoozed", "closed", "archived", "spam"])
            .optional(),
        })
        .parse(request.body);
      const rows = await sql<
        Row[]
      >`SELECT c.id,c.status,c.priority,c.last_message_at,ct.display_name,ct.normalized_phone,ch.name channel_name,u.full_name assignee_name FROM conversations c JOIN contacts ct ON ct.id=c.contact_id AND ct.organization_id=c.organization_id JOIN channels ch ON ch.id=c.channel_id AND ch.organization_id=c.organization_id LEFT JOIN users u ON u.id=c.assignee_id WHERE c.organization_id=${request.claims!.organizationId}::uuid AND (${body.status ?? null}::text IS NULL OR c.status::text=${body.status ?? null}) AND (${!["agent", "team_lead"].includes(request.claims!.role)} OR EXISTS (SELECT 1 FROM channel_user_ownership cuo WHERE cuo.organization_id=c.organization_id AND cuo.channel_id=c.channel_id AND cuo.user_id=${request.claims!.sub}::uuid)) ORDER BY c.last_message_at DESC`;
      await sql`INSERT INTO audit_logs(organization_id,actor_id,action,entity_type,metadata) VALUES(${request.claims!.organizationId}::uuid,${request.claims!.sub}::uuid,'conversation.export','conversation',${sql.json({ format: body.format, count: rows.length, status: body.status ?? null } as never)})`;
      if (body.format === "json")
        return reply
          .header(
            "content-disposition",
            'attachment; filename="conversations.json"',
          )
          .send(rows);
      const headers = [
        "id",
        "status",
        "priority",
        "last_message_at",
        "display_name",
        "normalized_phone",
        "channel_name",
        "assignee_name",
      ];
      const escape = (value: unknown) =>
        `"${String(value ?? "").replaceAll('"', '""')}"`;
      const csv = [
        headers.join(","),
        ...rows.map((row) => headers.map((key) => escape(row[key])).join(",")),
      ].join("\n");
      return reply
        .type("text/csv; charset=utf-8")
        .header(
          "content-disposition",
          'attachment; filename="conversations.csv"',
        )
        .send(csv);
    },
  );

  app.get(
    "/api/v1/assignment-rules",
    { preHandler: options.authorize("conversation:assign") },
    async (request) => ({
      data: await sql`SELECT * FROM assignment_rules WHERE organization_id=${request.claims!.organizationId}::uuid ORDER BY priority,name`,
    }),
  );
  app.post(
    "/api/v1/assignment-rules",
    { preHandler: options.authorize("conversation:assign") },
    async (request, reply) => {
      const body = z
        .object({
          name: z.string().min(1).max(80),
          priority: z.number().int().min(0).max(10000).default(100),
          strategy: z
            .enum(["round_robin", "least_loaded", "fixed"])
            .default("round_robin"),
          active: z.boolean().default(true),
          config: z.record(z.string(), z.unknown()).default({}),
        })
        .parse(request.body);
      const rows = await sql<
        Row[]
      >`INSERT INTO assignment_rules(organization_id,name,priority,active,strategy,config,created_by) VALUES(${request.claims!.organizationId}::uuid,${body.name},${body.priority},${body.active},${body.strategy},${sql.json(body.config as never)},${request.claims!.sub}::uuid) RETURNING *`;
      return reply.code(201).send({ data: rows[0] });
    },
  );
  app.get(
    "/api/v1/assignment-history",
    { preHandler: options.authorize("conversation:assign") },
    async (request) => {
      const query = z
        .object({
          conversationId: z.string().uuid().optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        })
        .parse(request.query);
      return {
        data: await sql`SELECT h.*,fu.full_name from_user_name,tu.full_name to_user_name FROM assignment_history h LEFT JOIN users fu ON fu.id=h.from_user_id LEFT JOIN users tu ON tu.id=h.to_user_id WHERE h.organization_id=${request.claims!.organizationId}::uuid AND (${query.conversationId ?? null}::text IS NULL OR h.conversation_id::text=${query.conversationId ?? null}) ORDER BY h.created_at DESC LIMIT ${query.limit}`,
      };
    },
  );
}
