import type { FastifyInstance, FastifyRequest } from "fastify";
import { can, type Permission } from "@brixchat/auth";
import type { LabelOperationsRepository } from "@brixchat/database";
import { z } from "zod";

type Authorize = (
  permission: Permission,
) => (request: FastifyRequest) => Promise<void>;
type Publish = (
  organizationId: string,
  event: Record<string, unknown>,
) => Promise<void>;
type Row = Record<string, unknown>;

interface Options {
  authorize: Authorize;
  publish: Publish;
}

const uuid = z.string().uuid();
const labelScope = z.enum(["workspace", "team", "channel"]);
const labelStatus = z.enum(["active", "archived"]);
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const labelBaseInput = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).nullable().default(null),
  color: hexColor,
  icon: z.string().trim().max(40).nullable().default(null),
  categoryId: uuid.nullable().default(null),
  scope: labelScope.default("workspace"),
  teamId: uuid.nullable().default(null),
  channelId: uuid.nullable().default(null),
  sortOrder: z.number().int().min(0).max(10000).default(0),
  isProtected: z.boolean().default(false),
});
const labelInput = labelBaseInput.superRefine((value, context) => {
  if (value.scope === "team" && !value.teamId)
    context.addIssue({
      code: "custom",
      path: ["teamId"],
      message: "Takım kapsamı için takım gereklidir.",
    });
  if (value.scope === "channel" && !value.channelId)
    context.addIssue({
      code: "custom",
      path: ["channelId"],
      message: "Kanal kapsamı için kanal gereklidir.",
    });
});
const labelUpdateInput = labelBaseInput
  .partial()
  .extend({ version: z.number().int().positive() })
  .superRefine((value, context) => {
    if (value.scope === "team" && value.teamId === null)
      context.addIssue({
        code: "custom",
        path: ["teamId"],
        message: "Takım kapsamı için takım gereklidir.",
      });
    if (value.scope === "channel" && value.channelId === null)
      context.addIssue({
        code: "custom",
        path: ["channelId"],
        message: "Kanal kapsamı için kanal gereklidir.",
      });
  });
const categoryInput = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).nullable().default(null),
  color: hexColor.nullable().default(null),
  sortOrder: z.number().int().min(0).max(10000).default(0),
  isRequiredGroup: z.boolean().default(false),
  selectionMode: z.enum(["multiple", "single"]).default("multiple"),
});
const mergeInput = z.object({
  targetLabelId: uuid,
  sourceVersion: z.number().int().positive(),
});
const bulkInput = z.object({
  operation: z.enum(["add", "remove", "replace"]),
  conversationIds: z.array(uuid).min(1).max(5000),
  labelId: uuid.nullable().default(null),
  replacementLabelId: uuid.nullable().default(null),
  idempotencyKey: z.string().trim().min(8).max(160),
});
const mappingInput = z.object({
  integrationConnectionId: uuid.nullable().default(null),
  entityType: z.enum(["contact", "deal"]),
  fieldId: z.string().trim().min(1).max(160),
  fieldValue: z.string().trim().min(1).max(500),
  syncDirection: z
    .enum(["brixchat_to_bitrix", "bitrix_to_brixchat", "bidirectional"])
    .default("bitrix_to_brixchat"),
  conflictPolicy: z
    .enum(["external_wins", "local_wins", "newest_wins", "manual"])
    .default("external_wins"),
  enabled: z.boolean().default(true),
});

export function normalizeLabelName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("tr-TR");
}

function labelEvent(
  eventType: string,
  organizationId: string,
  labelId: string,
  payload: Record<string, unknown>,
) {
  return {
    eventId: crypto.randomUUID(),
    eventType,
    organizationId,
    entityType: "label",
    entityId: labelId,
    occurredAt: new Date().toISOString(),
    payloadVersion: 1,
    payload,
  };
}

export function registerLabelRoutes(
  app: FastifyInstance,
  repository: LabelOperationsRepository,
  options: Options,
) {
  const dbQuery = repository.query.bind(repository);
  const visible = (request: FastifyRequest) => repository.fragment`
    (
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
      OR l.scope='channel' AND (
        ${["owner", "admin"].includes(request.claims!.role)}
        OR EXISTS(
          SELECT 1 FROM channel_user_ownership cuo
          WHERE cuo.organization_id=l.organization_id
            AND cuo.channel_id=l.channel_id
            AND cuo.user_id=${request.claims!.sub}::uuid
        )
      )
    )
  `;
  const audit = async (
    request: FastifyRequest,
    action: string,
    labelId: string,
    metadata: Record<string, unknown>,
  ) =>
    dbQuery`INSERT INTO audit_logs(
      organization_id,actor_id,action,entity_type,entity_id,metadata
    ) VALUES(
      ${request.claims!.organizationId}::uuid,
      ${request.claims!.sub}::uuid,
      ${action},'label',${labelId}::uuid,${repository.json(metadata)}
    )`;

  app.get(
    "/api/v1/labels",
    { preHandler: options.authorize("labels:read") },
    async (request) => {
      const query = z
        .object({
          search: z.string().trim().max(100).optional(),
          categoryId: uuid.optional(),
          scope: labelScope.optional(),
          teamId: uuid.optional(),
          channelId: uuid.optional(),
          status: labelStatus.default("active"),
          usage: z.enum(["used", "unused"]).optional(),
          sort: z
            .enum(["name", "usage", "recent", "sort_order"])
            .default("sort_order"),
          page: z.coerce.number().int().min(1).default(1),
          limit: z.coerce.number().int().min(1).max(100).default(50),
        })
        .parse(request.query);
      const offset = (query.page - 1) * query.limit;
      const order =
        query.sort === "usage"
          ? repository.fragment`l.usage_count DESC,l.name`
          : query.sort === "recent"
            ? repository.fragment`l.last_used_at DESC NULLS LAST,l.name`
            : query.sort === "name"
              ? repository.fragment`l.name`
              : repository.fragment`l.sort_order,l.name`;
      const rows = await dbQuery<Row[]>`
        SELECT l.*,lc.name category_name,lc.selection_mode,
          t.name team_name,ch.name channel_name,u.full_name updated_by_name,
          EXISTS(
            SELECT 1 FROM label_favorites lf
            WHERE lf.organization_id=l.organization_id
              AND lf.label_id=l.id
              AND lf.user_id=${request.claims!.sub}::uuid
          ) favorite
        FROM conversation_labels l
        LEFT JOIN label_categories lc ON lc.id=l.category_id
        LEFT JOIN teams t ON t.id=l.team_id
        LEFT JOIN channels ch ON ch.id=l.channel_id
        LEFT JOIN users u ON u.id=l.updated_by
        WHERE l.organization_id=${request.claims!.organizationId}::uuid
          AND l.deleted_at IS NULL
          AND l.status=${query.status}
          AND ${visible(request)}
          AND (${query.search ?? null}::text IS NULL
            OR l.name ILIKE ${`%${query.search ?? ""}%`}
            OR COALESCE(l.description,'') ILIKE ${`%${query.search ?? ""}%`})
          AND (${query.categoryId ?? null}::uuid IS NULL OR l.category_id=${query.categoryId ?? null}::uuid)
          AND (${query.scope ?? null}::text IS NULL OR l.scope=${query.scope ?? null})
          AND (${query.teamId ?? null}::uuid IS NULL OR l.team_id=${query.teamId ?? null}::uuid)
          AND (${query.channelId ?? null}::uuid IS NULL OR l.channel_id=${query.channelId ?? null}::uuid)
          AND (${query.usage ?? null}::text IS NULL
            OR ${query.usage ?? null}='used' AND l.usage_count>0
            OR ${query.usage ?? null}='unused' AND l.usage_count=0)
        ORDER BY ${order}
        LIMIT ${query.limit} OFFSET ${offset}`;
      const totals = (
        await dbQuery<Row[]>`
          SELECT count(*)::int total,
            count(*) FILTER(WHERE status='active')::int active,
            count(*) FILTER(WHERE status='archived')::int archived,
            count(*) FILTER(WHERE usage_count=0 AND status='active')::int unused,
            count(*) FILTER(WHERE scope='workspace' AND status='active')::int workspace,
            count(*) FILTER(WHERE scope='team' AND status='active')::int team,
            count(*) FILTER(WHERE scope='channel' AND status='active')::int channel,
            count(*) FILTER(WHERE automation_usage_count>0 AND status='active')::int automated
          FROM conversation_labels l
          WHERE l.organization_id=${request.claims!.organizationId}::uuid
            AND l.deleted_at IS NULL AND ${visible(request)}`
      )[0]!;
      return {
        data: rows,
        meta: {
          page: query.page,
          limit: query.limit,
          filteredCount: rows.length,
        },
        summary: totals,
      };
    },
  );

  app.get(
    "/api/v1/label-categories",
    { preHandler: options.authorize("labels:read") },
    async (request) => ({
      data: await dbQuery`
        SELECT lc.*,count(l.id)::int label_count
        FROM label_categories lc
        LEFT JOIN conversation_labels l
          ON l.category_id=lc.id AND l.deleted_at IS NULL
        WHERE lc.organization_id=${request.claims!.organizationId}::uuid
          AND lc.archived_at IS NULL
        GROUP BY lc.id ORDER BY lc.sort_order,lc.name`,
    }),
  );

  app.post(
    "/api/v1/label-categories",
    { preHandler: options.authorize("labels:categories") },
    async (request, reply) => {
      const body = categoryInput.parse(request.body);
      const normalized = normalizeLabelName(body.name);
      if (
        (
          await dbQuery`
            SELECT 1 FROM label_categories
            WHERE organization_id=${request.claims!.organizationId}::uuid
              AND normalized_name=${normalized} AND archived_at IS NULL`
        ).length
      )
        return reply.code(409).send({
          error: {
            code: "label_category_name_conflict",
            message: "Bu adla bir etiket kategorisi zaten var.",
          },
        });
      const rows = await dbQuery<Row[]>`
        INSERT INTO label_categories(
          organization_id,name,normalized_name,description,color,sort_order,
          is_required_group,selection_mode,created_by,updated_by
        ) VALUES(
          ${request.claims!.organizationId}::uuid,${body.name},${normalized},
          ${body.description},${body.color},${body.sortOrder},
          ${body.isRequiredGroup},${body.selectionMode},
          ${request.claims!.sub}::uuid,${request.claims!.sub}::uuid
        ) RETURNING *`;
      return reply.code(201).send({ data: rows[0] });
    },
  );

  app.post(
    "/api/v1/labels",
    { preHandler: options.authorize("labels:read") },
    async (request, reply) => {
      const body = labelInput.parse(request.body);
      const requiredPermission =
        body.scope === "workspace"
          ? "labels:create_workspace"
          : "labels:create_team";
      if (!can(request.claims!.role, requiredPermission))
        return reply.code(403).send({
          error: {
            code: "forbidden",
            message: "Etiket oluşturma yetkiniz yok.",
          },
        });
      if (
        body.scope === "team" &&
        !["owner", "admin"].includes(request.claims!.role) &&
        !(
          await dbQuery`SELECT 1 FROM team_members
            WHERE organization_id=${request.claims!.organizationId}::uuid
              AND team_id=${body.teamId}::uuid
              AND user_id=${request.claims!.sub}::uuid`
        ).length
      )
        return reply.code(403).send({
          error: {
            code: "team_scope_forbidden",
            message: "Bu takıma erişiminiz yok.",
          },
        });
      if (
        body.scope === "channel" &&
        !["owner", "admin"].includes(request.claims!.role) &&
        !(
          await dbQuery`SELECT 1 FROM channel_user_ownership
            WHERE organization_id=${request.claims!.organizationId}::uuid
              AND channel_id=${body.channelId}::uuid
              AND user_id=${request.claims!.sub}::uuid`
        ).length
      )
        return reply.code(403).send({
          error: {
            code: "channel_scope_forbidden",
            message: "Bu kanala erişiminiz yok.",
          },
        });
      const normalized = normalizeLabelName(body.name);
      if (
        (
          await dbQuery`
            SELECT 1 FROM conversation_labels
            WHERE organization_id=${request.claims!.organizationId}::uuid
              AND normalized_name=${normalized}
              AND deleted_at IS NULL AND status<>'merged'`
        ).length
      )
        return reply.code(409).send({
          error: {
            code: "label_name_conflict",
            message: "Bu adla etkin veya arşivlenmiş bir etiket zaten var.",
          },
        });
      const rows = await dbQuery<Row[]>`
        INSERT INTO conversation_labels(
          organization_id,name,normalized_name,description,color,icon,category_id,
          scope,team_id,channel_id,sort_order,is_protected,created_by,updated_by
        ) VALUES(
          ${request.claims!.organizationId}::uuid,${body.name},${normalized},
          ${body.description},${body.color},${body.icon},${body.categoryId}::uuid,
          ${body.scope},
          ${body.scope === "team" ? body.teamId : null}::uuid,
          ${body.scope === "channel" ? body.channelId : null}::uuid,
          ${body.sortOrder},
          ${["owner", "admin"].includes(request.claims!.role) && body.isProtected},
          ${request.claims!.sub}::uuid,${request.claims!.sub}::uuid
        ) RETURNING *`;
      await Promise.all([
        audit(request, "label.created", String(rows[0]!.id), {
          scope: body.scope,
          categoryId: body.categoryId,
        }),
        options.publish(
          request.claims!.organizationId,
          labelEvent(
            "label.created",
            request.claims!.organizationId,
            String(rows[0]!.id),
            { label: rows[0] },
          ),
        ),
      ]);
      return reply.code(201).send({ data: rows[0] });
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/v1/labels/:id",
    { preHandler: options.authorize("labels:read") },
    async (request, reply) => {
      const rows = await dbQuery<Row[]>`
        SELECT l.*,lc.name category_name,lc.selection_mode,
          t.name team_name,ch.name channel_name,u.full_name updated_by_name
        FROM conversation_labels l
        LEFT JOIN label_categories lc ON lc.id=l.category_id
        LEFT JOIN teams t ON t.id=l.team_id
        LEFT JOIN channels ch ON ch.id=l.channel_id
        LEFT JOIN users u ON u.id=l.updated_by
        WHERE l.id=${request.params.id}::uuid
          AND l.organization_id=${request.claims!.organizationId}::uuid
          AND l.deleted_at IS NULL AND ${visible(request)}`;
      return rows[0]
        ? { data: rows[0] }
        : reply.code(404).send({
            error: { code: "label_not_found", message: "Etiket bulunamadı." },
          });
    },
  );

  app.patch<{ Params: { id: string } }>(
    "/api/v1/labels/:id",
    { preHandler: options.authorize("labels:update") },
    async (request, reply) => {
      const body = labelUpdateInput.parse(request.body);
      const current = (
        await dbQuery<Row[]>`
          SELECT * FROM conversation_labels l
          WHERE id=${request.params.id}::uuid
            AND organization_id=${request.claims!.organizationId}::uuid
            AND deleted_at IS NULL AND ${visible(request)}
          FOR UPDATE`
      )[0];
      if (!current)
        return reply.code(404).send({
          error: { code: "label_not_found", message: "Etiket bulunamadı." },
        });
      if (Number(current.version) !== body.version)
        return reply.code(409).send({
          error: {
            code: "label_version_conflict",
            message: "Etiket başka bir kullanıcı tarafından güncellendi.",
          },
        });
      if (
        current.is_system &&
        !["owner", "admin"].includes(request.claims!.role)
      )
        return reply.code(403).send({
          error: {
            code: "system_label_protected",
            message: "Sistem etiketi korunuyor.",
          },
        });
      const nextScope = body.scope ?? String(current.scope);
      const nextTeamId =
        nextScope === "team"
          ? body.teamId === undefined
            ? (current.team_id as string | null)
            : body.teamId
          : null;
      const nextChannelId =
        nextScope === "channel"
          ? body.channelId === undefined
            ? (current.channel_id as string | null)
            : body.channelId
          : null;
      if (
        (nextScope === "team" && !nextTeamId) ||
        (nextScope === "channel" && !nextChannelId)
      )
        return reply.code(400).send({
          error: {
            code: "label_scope_target_required",
            message: "Kapsam için takım veya kanal seçilmelidir.",
          },
        });
      if (
        nextScope === "workspace" &&
        !can(request.claims!.role, "labels:create_workspace")
      )
        return reply.code(403).send({
          error: {
            code: "label_workspace_scope_forbidden",
            message: "Workspace kapsamını yalnızca yönetici seçebilir.",
          },
        });
      if (
        nextScope === "team" &&
        !["owner", "admin"].includes(request.claims!.role) &&
        !(
          await dbQuery`SELECT 1 FROM team_members
            WHERE organization_id=${request.claims!.organizationId}::uuid
              AND team_id=${nextTeamId}::uuid
              AND user_id=${request.claims!.sub}::uuid`
        ).length
      )
        return reply.code(403).send({
          error: {
            code: "team_scope_forbidden",
            message: "Bu takıma erişiminiz yok.",
          },
        });
      if (
        nextScope === "channel" &&
        !["owner", "admin"].includes(request.claims!.role) &&
        !(
          await dbQuery`SELECT 1 FROM channel_user_ownership
            WHERE organization_id=${request.claims!.organizationId}::uuid
              AND channel_id=${nextChannelId}::uuid
              AND user_id=${request.claims!.sub}::uuid`
        ).length
      )
        return reply.code(403).send({
          error: {
            code: "channel_scope_forbidden",
            message: "Bu kanala erişiminiz yok.",
          },
        });
      if (
        body.name &&
        (
          await dbQuery`
            SELECT 1 FROM conversation_labels
            WHERE organization_id=${request.claims!.organizationId}::uuid
              AND normalized_name=${normalizeLabelName(body.name)}
              AND id<>${request.params.id}::uuid
              AND deleted_at IS NULL AND status<>'merged'`
        ).length
      )
        return reply.code(409).send({
          error: {
            code: "label_name_conflict",
            message: "Bu adla etkin veya arşivlenmiş bir etiket zaten var.",
          },
        });
      const rows = await dbQuery<Row[]>`
        UPDATE conversation_labels SET
          name=COALESCE(${body.name ?? null},name),
          normalized_name=COALESCE(${body.name ? normalizeLabelName(body.name) : null},normalized_name),
          description=CASE WHEN ${body.description === undefined} THEN description ELSE ${body.description ?? null} END,
          color=COALESCE(${body.color ?? null},color),
          icon=CASE WHEN ${body.icon === undefined} THEN icon ELSE ${body.icon ?? null} END,
          category_id=CASE WHEN ${body.categoryId === undefined} THEN category_id ELSE ${body.categoryId ?? null}::uuid END,
          scope=${nextScope},team_id=${nextTeamId}::uuid,channel_id=${nextChannelId}::uuid,
          sort_order=COALESCE(${body.sortOrder ?? null},sort_order),
          is_protected=CASE
            WHEN ${["owner", "admin"].includes(request.claims!.role)}
              THEN COALESCE(${body.isProtected ?? null},is_protected)
            ELSE is_protected END,
          updated_by=${request.claims!.sub}::uuid,
          version=version+1,updated_at=now()
        WHERE id=${request.params.id}::uuid
          AND organization_id=${request.claims!.organizationId}::uuid
          AND version=${body.version}
        RETURNING *`;
      await Promise.all([
        audit(request, "label.updated", request.params.id, {
          before: current,
          changed: Object.keys(body).filter((key) => key !== "version"),
        }),
        options.publish(
          request.claims!.organizationId,
          labelEvent(
            "label.updated",
            request.claims!.organizationId,
            request.params.id,
            { label: rows[0] },
          ),
        ),
      ]);
      return { data: rows[0] };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/v1/labels/:id/archive",
    { preHandler: options.authorize("labels:archive") },
    async (request, reply) => {
      const rows = await dbQuery<Row[]>`
        UPDATE conversation_labels l SET
          status='archived',archived_at=now(),updated_by=${request.claims!.sub}::uuid,
          version=version+1,updated_at=now()
        WHERE id=${request.params.id}::uuid
          AND organization_id=${request.claims!.organizationId}::uuid
          AND status='active' AND deleted_at IS NULL
          AND NOT is_protected AND ${visible(request)}
        RETURNING *`;
      if (!rows[0])
        return reply.code(409).send({
          error: {
            code: "label_not_archivable",
            message: "Etiket bulunamadı veya korumalı.",
          },
        });
      await Promise.all([
        audit(request, "label.archived", request.params.id, {}),
        options.publish(
          request.claims!.organizationId,
          labelEvent(
            "label.archived",
            request.claims!.organizationId,
            request.params.id,
            { label: rows[0] },
          ),
        ),
      ]);
      return { data: rows[0] };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/v1/labels/:id/restore",
    { preHandler: options.authorize("labels:archive") },
    async (request, reply) => {
      const rows = await dbQuery<Row[]>`
        UPDATE conversation_labels l SET
          status='active',archived_at=NULL,updated_by=${request.claims!.sub}::uuid,
          version=version+1,updated_at=now()
        WHERE id=${request.params.id}::uuid
          AND organization_id=${request.claims!.organizationId}::uuid
          AND status='archived' AND deleted_at IS NULL AND ${visible(request)}
        RETURNING *`;
      if (!rows[0])
        return reply.code(404).send({
          error: { code: "label_not_found", message: "Etiket bulunamadı." },
        });
      await Promise.all([
        audit(request, "label.restored", request.params.id, {}),
        options.publish(
          request.claims!.organizationId,
          labelEvent(
            "label.restored",
            request.claims!.organizationId,
            request.params.id,
            { label: rows[0] },
          ),
        ),
      ]);
      return { data: rows[0] };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/v1/labels/:id/duplicate",
    { preHandler: options.authorize("labels:read") },
    async (request, reply) => {
      const current = (
        await dbQuery<Row[]>`
          SELECT * FROM conversation_labels l
          WHERE id=${request.params.id}::uuid
            AND organization_id=${request.claims!.organizationId}::uuid
            AND deleted_at IS NULL AND ${visible(request)}`
      )[0];
      if (!current)
        return reply.code(404).send({
          error: { code: "label_not_found", message: "Etiket bulunamadı." },
        });
      const duplicatePermission =
        current.scope === "workspace"
          ? "labels:create_workspace"
          : "labels:create_team";
      if (!can(request.claims!.role, duplicatePermission))
        return reply.code(403).send({
          error: {
            code: "label_duplicate_forbidden",
            message: "Bu kapsamdaki etiketi kopyalama yetkiniz yok.",
          },
        });
      const suffix = crypto.randomUUID().slice(0, 6);
      const name = `${String(current.name)} kopya ${suffix}`;
      const rows = await dbQuery<Row[]>`
        INSERT INTO conversation_labels(
          organization_id,name,normalized_name,description,color,icon,category_id,
          scope,team_id,channel_id,sort_order,created_by,updated_by
        ) VALUES(
          ${request.claims!.organizationId}::uuid,${name},${normalizeLabelName(name)},
          ${current.description as string | null},${String(current.color)},
          ${current.icon as string | null},${current.category_id as string | null}::uuid,
          ${String(current.scope)},${current.team_id as string | null}::uuid,
          ${current.channel_id as string | null}::uuid,${Number(current.sort_order)},
          ${request.claims!.sub}::uuid,${request.claims!.sub}::uuid
        ) RETURNING *`;
      await audit(request, "label.duplicated", String(rows[0]!.id), {
        sourceLabelId: request.params.id,
      });
      return reply.code(201).send({ data: rows[0] });
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/v1/labels/:id/dependencies",
    { preHandler: options.authorize("labels:read") },
    async (request) => ({
      data: (
        await dbQuery<Row[]>`
          SELECT
            (SELECT count(*)::int FROM conversation_label_assignments
              WHERE organization_id=${request.claims!.organizationId}::uuid
                AND label_id=${request.params.id}::uuid) conversations,
            (SELECT count(*)::int
              FROM automation_rule_actions a
              JOIN automation_rule_versions v ON v.id=a.version_id
              JOIN automation_rules r ON r.id=v.rule_id
              WHERE r.organization_id=${request.claims!.organizationId}::uuid
                AND a.config->>'labelId'=${request.params.id}) automations,
            (SELECT count(*)::int FROM label_bitrix_mappings
              WHERE organization_id=${request.claims!.organizationId}::uuid
                AND label_id=${request.params.id}::uuid AND enabled) mappings,
            (SELECT count(*)::int FROM label_favorites
              WHERE organization_id=${request.claims!.organizationId}::uuid
                AND label_id=${request.params.id}::uuid) favorites`
      )[0],
    }),
  );

  app.delete<{ Params: { id: string } }>(
    "/api/v1/labels/:id",
    { preHandler: options.authorize("labels:delete") },
    async (request, reply) => {
      const current = (
        await dbQuery<Row[]>`
          SELECT l.*,
            EXISTS(SELECT 1 FROM conversation_label_assignments a WHERE a.label_id=l.id) used,
            EXISTS(
              SELECT 1 FROM automation_rule_actions a
              JOIN automation_rule_versions v ON v.id=a.version_id
              JOIN automation_rules r ON r.id=v.rule_id
              WHERE r.organization_id=l.organization_id
                AND a.config->>'labelId'=l.id::text
            ) automated
          FROM conversation_labels l
          WHERE l.id=${request.params.id}::uuid
            AND l.organization_id=${request.claims!.organizationId}::uuid
            AND l.deleted_at IS NULL`
      )[0];
      if (!current)
        return reply.code(404).send({
          error: { code: "label_not_found", message: "Etiket bulunamadı." },
        });
      if (current.is_protected || current.is_system)
        return reply.code(409).send({
          error: {
            code: "label_protected",
            message: "Sistem veya korumalı etiket silinemez.",
          },
        });
      if (current.used || current.automated)
        return reply.code(409).send({
          error: {
            code: "label_has_dependencies",
            message: "Etiket kullanımda. Önce birleştirin veya arşivleyin.",
          },
        });
      await dbQuery`
        UPDATE conversation_labels SET
          status='deleted',deleted_at=now(),archived_at=COALESCE(archived_at,now()),
          updated_by=${request.claims!.sub}::uuid,version=version+1,updated_at=now()
        WHERE id=${request.params.id}::uuid
          AND organization_id=${request.claims!.organizationId}::uuid`;
      await Promise.all([
        audit(request, "label.deleted", request.params.id, {}),
        options.publish(
          request.claims!.organizationId,
          labelEvent(
            "label.deleted",
            request.claims!.organizationId,
            request.params.id,
            {},
          ),
        ),
      ]);
      return { data: { deleted: true } };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/v1/labels/:id/merge",
    { preHandler: options.authorize("labels:merge") },
    async (request, reply) => {
      const body = mergeInput.parse(request.body);
      if (body.targetLabelId === request.params.id)
        return reply.code(400).send({
          error: {
            code: "label_merge_same_target",
            message: "Hedef farklı olmalıdır.",
          },
        });
      const result = await repository.begin(async (tx) => {
        const labels = await tx<Row[]>`
          SELECT * FROM conversation_labels
          WHERE organization_id=${request.claims!.organizationId}::uuid
            AND id IN(${request.params.id}::uuid,${body.targetLabelId}::uuid)
            AND deleted_at IS NULL
          ORDER BY id FOR UPDATE`;
        const source = labels.find(
          (item) => String(item.id) === request.params.id,
        );
        const target = labels.find(
          (item) => String(item.id) === body.targetLabelId,
        );
        if (!source || !target) return { error: "not_found" } as const;
        if (Number(source.version) !== body.sourceVersion)
          return { error: "version_conflict" } as const;
        if (source.is_protected || source.is_system)
          return { error: "protected" } as const;
        const inserted = await tx<Row[]>`
          INSERT INTO conversation_label_assignments(
            organization_id,conversation_id,label_id,assigned_by,source,
            automation_id,assigned_at,expires_at,metadata,correlation_id
          )
          SELECT organization_id,conversation_id,${body.targetLabelId}::uuid,
            assigned_by,source,automation_id,assigned_at,expires_at,metadata,correlation_id
          FROM conversation_label_assignments
          WHERE organization_id=${request.claims!.organizationId}::uuid
            AND label_id=${request.params.id}::uuid
          ON CONFLICT(conversation_id,label_id) DO NOTHING
          RETURNING conversation_id`;
        await tx`DELETE FROM conversation_label_assignments
          WHERE organization_id=${request.claims!.organizationId}::uuid
            AND label_id=${request.params.id}::uuid`;
        await tx`
          UPDATE automation_rule_actions a SET
            config=jsonb_set(config,'{labelId}',to_jsonb(${body.targetLabelId}::text))
          FROM automation_rule_versions v,automation_rules r
          WHERE a.version_id=v.id AND v.rule_id=r.id
            AND r.organization_id=${request.claims!.organizationId}::uuid
            AND a.config->>'labelId'=${request.params.id}`;
        await tx`
          INSERT INTO label_favorites(organization_id,user_id,label_id)
          SELECT organization_id,user_id,${body.targetLabelId}::uuid
          FROM label_favorites
          WHERE organization_id=${request.claims!.organizationId}::uuid
            AND label_id=${request.params.id}::uuid
          ON CONFLICT DO NOTHING`;
        await tx`DELETE FROM label_favorites
          WHERE organization_id=${request.claims!.organizationId}::uuid
            AND label_id=${request.params.id}::uuid`;
        await tx`
          DELETE FROM label_bitrix_mappings source
          USING label_bitrix_mappings target
          WHERE source.organization_id=${request.claims!.organizationId}::uuid
            AND source.label_id=${request.params.id}::uuid
            AND target.organization_id=source.organization_id
            AND target.label_id=${body.targetLabelId}::uuid
            AND target.integration_connection_id IS NOT DISTINCT FROM source.integration_connection_id
            AND target.entity_type=source.entity_type
            AND target.field_id=source.field_id
            AND target.field_value=source.field_value`;
        await tx`UPDATE label_bitrix_mappings SET
          label_id=${body.targetLabelId}::uuid,updated_at=now()
          WHERE organization_id=${request.claims!.organizationId}::uuid
            AND label_id=${request.params.id}::uuid`;
        await tx`UPDATE conversation_labels SET
          status='merged',merged_into_id=${body.targetLabelId}::uuid,
          archived_at=now(),updated_by=${request.claims!.sub}::uuid,
          version=version+1,updated_at=now()
          WHERE id=${request.params.id}::uuid`;
        await tx`INSERT INTO label_usage_events(
          organization_id,label_id,actor_id,event_type,source,metadata
        ) VALUES(
          ${request.claims!.organizationId}::uuid,${body.targetLabelId}::uuid,
          ${request.claims!.sub}::uuid,'merged','manual',
          ${tx.json({ sourceLabelId: request.params.id, moved: inserted.length } as never)}
        )`;
        return { moved: inserted.length };
      });
      if ("error" in result)
        return reply
          .code(result.error === "version_conflict" ? 409 : 404)
          .send({
            error: {
              code: `label_merge_${result.error}`,
              message: "Etiket birleştirme koşulları sağlanmadı.",
            },
          });
      await Promise.all([
        audit(request, "label.merged", request.params.id, {
          targetLabelId: body.targetLabelId,
          moved: result.moved,
        }),
        options.publish(
          request.claims!.organizationId,
          labelEvent(
            "label.merged",
            request.claims!.organizationId,
            request.params.id,
            { targetLabelId: body.targetLabelId, moved: result.moved },
          ),
        ),
      ]);
      return { data: result };
    },
  );

  app.post(
    "/api/v1/labels/bulk/conversations",
    {
      preHandler: options.authorize("labels:bulk"),
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const body = bulkInput.parse(request.body);
      if (!body.labelId)
        return reply.code(400).send({
          error: { code: "label_required", message: "Etiket seçilmelidir." },
        });
      if (body.operation === "replace" && !body.replacementLabelId)
        return reply.code(400).send({
          error: {
            code: "replacement_label_required",
            message: "Hedef etiket seçilmelidir.",
          },
        });
      const rows = await dbQuery<Row[]>`
        INSERT INTO label_bulk_jobs(
          organization_id,requested_by,operation,conversation_ids,label_id,
          replacement_label_id,idempotency_key,total_count
        ) VALUES(
          ${request.claims!.organizationId}::uuid,${request.claims!.sub}::uuid,
          ${body.operation},${body.conversationIds}::uuid[],${body.labelId}::uuid,
          ${body.replacementLabelId}::uuid,${body.idempotencyKey},
          ${body.conversationIds.length}
        )
        ON CONFLICT(organization_id,idempotency_key)
        DO UPDATE SET updated_at=label_bulk_jobs.updated_at
        RETURNING *`;
      await audit(request, "label.bulk_queued", String(rows[0]!.id), {
        operation: body.operation,
        total: body.conversationIds.length,
      });
      return reply.code(202).send({ data: rows[0] });
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/v1/label-bulk-jobs/:id",
    { preHandler: options.authorize("labels:bulk") },
    async (request, reply) => {
      const rows = await dbQuery<Row[]>`
        SELECT * FROM label_bulk_jobs
        WHERE id=${request.params.id}::uuid
          AND organization_id=${request.claims!.organizationId}::uuid`;
      return rows[0]
        ? { data: rows[0] }
        : reply.code(404).send({
            error: { code: "label_job_not_found", message: "İş bulunamadı." },
          });
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/v1/labels/:id/analytics",
    { preHandler: options.authorize("labels:analytics") },
    async (request) => ({
      data:
        (
          await dbQuery<Row[]>`
          SELECT
            l.usage_count total_usage,l.last_used_at,
            count(*) FILTER(WHERE c.status IN('open','waiting'))::int active_conversations,
            count(*) FILTER(WHERE c.status='closed')::int closed_conversations,
            count(*) FILTER(WHERE a.assigned_at>now()-interval '7 days')::int usage_7d,
            count(*) FILTER(WHERE a.assigned_at>now()-interval '30 days')::int usage_30d,
            count(*) FILTER(WHERE a.assigned_at>now()-interval '90 days')::int usage_90d,
            count(*) FILTER(WHERE a.source='manual')::int manual_usage,
            count(*) FILTER(WHERE a.source='automation')::int automation_usage,
            count(*) FILTER(WHERE a.source='bitrix')::int bitrix_usage,
            (SELECT count(*)::int FROM label_bitrix_mappings m
              WHERE m.organization_id=l.organization_id AND m.label_id=l.id
                AND m.enabled) mapping_count
          FROM conversation_labels l
          LEFT JOIN conversation_label_assignments a ON a.label_id=l.id
          LEFT JOIN conversations c ON c.id=a.conversation_id
          WHERE l.id=${request.params.id}::uuid
            AND l.organization_id=${request.claims!.organizationId}::uuid
          GROUP BY l.id`
        )[0] ?? null,
    }),
  );

  app.get<{ Params: { id: string } }>(
    "/api/v1/labels/:id/mappings",
    { preHandler: options.authorize("labels:mappings") },
    async (request) => ({
      data: await dbQuery`
        SELECT * FROM label_bitrix_mappings
        WHERE organization_id=${request.claims!.organizationId}::uuid
          AND label_id=${request.params.id}::uuid
        ORDER BY created_at`,
    }),
  );

  app.post<{ Params: { id: string } }>(
    "/api/v1/labels/:id/mappings",
    { preHandler: options.authorize("labels:mappings") },
    async (request, reply) => {
      const body = mappingInput.parse(request.body);
      const rows = await dbQuery<Row[]>`
        INSERT INTO label_bitrix_mappings(
          organization_id,label_id,integration_connection_id,entity_type,
          field_id,field_value,sync_direction,conflict_policy,enabled,
          created_by,updated_by
        )
        SELECT ${request.claims!.organizationId}::uuid,l.id,
          ${body.integrationConnectionId}::uuid,${body.entityType},
          ${body.fieldId},${body.fieldValue},${body.syncDirection},
          ${body.conflictPolicy},${body.enabled},
          ${request.claims!.sub}::uuid,${request.claims!.sub}::uuid
        FROM conversation_labels l
        WHERE l.id=${request.params.id}::uuid
          AND l.organization_id=${request.claims!.organizationId}::uuid
          AND l.deleted_at IS NULL
        RETURNING *`;
      if (!rows[0])
        return reply.code(404).send({
          error: { code: "label_not_found", message: "Etiket bulunamadı." },
        });
      await audit(request, "label.mapping_created", request.params.id, {
        entityType: body.entityType,
        direction: body.syncDirection,
      });
      return reply.code(201).send({ data: rows[0] });
    },
  );
}
