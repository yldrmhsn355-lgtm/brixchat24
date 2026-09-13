import type postgres from "postgres";

type DatabaseClient = ReturnType<typeof postgres>;
type Row = Record<string, unknown>;

const organizationSortColumns = {
  name: "name",
  created_at: "created_at",
  status: "operational_status",
  plan: "plan_name",
} as const;

export type PlatformOrganizationSort = keyof typeof organizationSortColumns;
export type OrganizationStatus =
  "pending_review" | "active" | "disabled" | "rejected";
export type PlatformHealthFilter = "healthy" | "attention" | "critical";

export class PlatformAdminRepository {
  constructor(private readonly sql: DatabaseClient) {}

  async listOrganizations(input: {
    term: string | null;
    limit: number;
    offset: number;
    sort: PlatformOrganizationSort;
    direction: "ASC" | "DESC";
    status?: OrganizationStatus | null;
    plan?: string | null;
    trial?: string | null;
    health?: PlatformHealthFilter | null;
    createdFrom?: Date | null;
    createdTo?: Date | null;
  }) {
    const orderBy = this.sql.unsafe(
      `${organizationSortColumns[input.sort]} ${input.direction}, id ${input.direction}`,
    );
    const healthCase = `CASE
      WHEN EXISTS(SELECT 1 FROM channels c WHERE c.organization_id=o.id AND (c.health_state IN ('UNHEALTHY','CRITICAL') OR c.connection_status IN ('DISCONNECTED','ERROR')))
        OR EXISTS(SELECT 1 FROM integration_connections i WHERE i.organization_id=o.id AND i.status='error')
        THEN 'critical'
      WHEN EXISTS(SELECT 1 FROM channels c WHERE c.organization_id=o.id AND (c.health_state IN ('UNKNOWN','DEGRADED') OR c.connection_status NOT IN ('ACTIVE','CONNECTED')))
        OR EXISTS(SELECT 1 FROM integration_connections i WHERE i.organization_id=o.id AND i.status IN ('degraded','disconnected','warning'))
        THEN 'attention'
      ELSE 'healthy' END`;
    const createdFrom = input.createdFrom?.toISOString() ?? null;
    const createdTo = input.createdTo?.toISOString() ?? null;
    if (!input.health) {
      const [rows, totals] = await Promise.all([
        this.sql<Row[]>`
          WITH page AS (
            SELECT o.id,o.name,o.slug,o.industry,o.operational_status,
              o.activation_status,o.status_reason,o.activation_requested_at,
              o.activated_at,o.disabled_at,o.created_at,
              p.code plan_code,p.display_name plan_name,
              e.trial_status,e.trial_ends_at,e.grace_ends_at
            FROM organizations o
            LEFT JOIN organization_entitlements e ON e.organization_id=o.id
            LEFT JOIN plans p ON p.id=e.plan_id
            WHERE (${input.term}::text IS NULL OR o.name ILIKE ${input.term} OR o.slug ILIKE ${input.term})
              AND (${input.status ?? null}::text IS NULL OR o.operational_status=${input.status ?? null})
              AND (${input.plan ?? null}::text IS NULL OR p.code=${input.plan ?? null})
              AND (${input.trial ?? null}::text IS NULL OR e.trial_status=${input.trial ?? null})
              AND (${createdFrom}::timestamptz IS NULL OR o.created_at>=${createdFrom}::timestamptz)
              AND (${createdTo}::timestamptz IS NULL OR o.created_at<${createdTo}::timestamptz)
            ORDER BY ${orderBy} LIMIT ${input.limit} OFFSET ${input.offset}
          )
          SELECT o.*,
            (SELECT count(*)::int FROM organization_members m WHERE m.organization_id=o.id) member_count,
            (SELECT max(u.last_login_at) FROM organization_members m JOIN users u ON u.id=m.user_id WHERE m.organization_id=o.id) last_activity_at,
            ${this.sql.unsafe(healthCase)} health_status
          FROM page o ORDER BY ${orderBy}`,
        this.sql<Array<{ count: number }>>`
          SELECT count(*)::int count FROM organizations o
          LEFT JOIN organization_entitlements e ON e.organization_id=o.id
          LEFT JOIN plans p ON p.id=e.plan_id
          WHERE (${input.term}::text IS NULL OR o.name ILIKE ${input.term} OR o.slug ILIKE ${input.term})
            AND (${input.status ?? null}::text IS NULL OR o.operational_status=${input.status ?? null})
            AND (${input.plan ?? null}::text IS NULL OR p.code=${input.plan ?? null})
            AND (${input.trial ?? null}::text IS NULL OR e.trial_status=${input.trial ?? null})
            AND (${createdFrom}::timestamptz IS NULL OR o.created_at>=${createdFrom}::timestamptz)
            AND (${createdTo}::timestamptz IS NULL OR o.created_at<${createdTo}::timestamptz)`,
      ]);
      return { rows, total: totals[0]!.count };
    }
    const [rows, totals] = await Promise.all([
      this.sql<Row[]>`
        WITH organization_rows AS (
          SELECT o.id,o.name,o.slug,o.industry,o.operational_status,
            o.activation_status,o.status_reason,o.activation_requested_at,
            o.activated_at,o.disabled_at,o.created_at,
            p.code plan_code,p.display_name plan_name,
            e.trial_status,e.trial_ends_at,e.grace_ends_at,
            (SELECT count(*)::int FROM organization_members m WHERE m.organization_id=o.id) member_count,
            (SELECT max(u.last_login_at) FROM organization_members m JOIN users u ON u.id=m.user_id WHERE m.organization_id=o.id) last_activity_at,
            ${this.sql.unsafe(healthCase)} health_status
          FROM organizations o
          LEFT JOIN organization_entitlements e ON e.organization_id=o.id
          LEFT JOIN plans p ON p.id=e.plan_id
          WHERE (${input.term}::text IS NULL OR o.name ILIKE ${input.term} OR o.slug ILIKE ${input.term})
            AND (${input.status ?? null}::text IS NULL OR o.operational_status=${input.status ?? null})
            AND (${input.plan ?? null}::text IS NULL OR p.code=${input.plan ?? null})
            AND (${input.trial ?? null}::text IS NULL OR e.trial_status=${input.trial ?? null})
            AND (${createdFrom}::timestamptz IS NULL OR o.created_at>=${createdFrom}::timestamptz)
            AND (${createdTo}::timestamptz IS NULL OR o.created_at<${createdTo}::timestamptz)
        )
        SELECT * FROM organization_rows
        WHERE (${input.health ?? null}::text IS NULL OR health_status=${input.health ?? null})
        ORDER BY ${orderBy}
        LIMIT ${input.limit} OFFSET ${input.offset}`,
      this.sql<Array<{ count: number }>>`
        SELECT count(*)::int count
        FROM organizations o
        LEFT JOIN organization_entitlements e ON e.organization_id=o.id
        LEFT JOIN plans p ON p.id=e.plan_id
        WHERE (${input.term}::text IS NULL OR o.name ILIKE ${input.term} OR o.slug ILIKE ${input.term})
          AND (${input.status ?? null}::text IS NULL OR o.operational_status=${input.status ?? null})
          AND (${input.plan ?? null}::text IS NULL OR p.code=${input.plan ?? null})
          AND (${input.trial ?? null}::text IS NULL OR e.trial_status=${input.trial ?? null})
          AND (${createdFrom}::timestamptz IS NULL OR o.created_at>=${createdFrom}::timestamptz)
          AND (${createdTo}::timestamptz IS NULL OR o.created_at<${createdTo}::timestamptz)
          AND (${input.health ?? null}::text IS NULL OR (${this.sql.unsafe(healthCase)})=${input.health ?? null})`,
    ]);
    return { rows, total: totals[0]!.count };
  }

  async activePlanId(code: string): Promise<string | null> {
    const [plan] = await this.sql<Array<{ id: string }>>`
      SELECT id FROM plans WHERE code=${code} AND active=true`;
    return plan?.id ?? null;
  }

  async createOrganization(input: {
    name: string;
    slug: string;
    planId: string;
    planCode: string;
    trialDays: number;
    ownerEmail?: string;
    ownerFullName?: string;
    ownerPassword?: string;
    ownerPasswordHash?: string;
    actorId: string;
    activateNow?: boolean;
  }) {
    return this.sql.begin(async (tx) => {
      const activateNow = input.activateNow !== false;
      const [organization] = await tx<Array<{ id: string }>>`
        INSERT INTO organizations(
          name,slug,operational_status,activation_status,
          activation_requested_at,activated_at,activated_by,
          status_changed_at,status_changed_by
        ) VALUES(
          ${input.name},${input.slug},${activateNow ? "active" : "pending_review"},
          ${activateNow ? "approved" : "pending"},now(),
          ${activateNow ? new Date().toISOString() : null}::timestamptz,${activateNow ? input.actorId : null}::uuid,
          now(),${input.actorId}::uuid
        )
        RETURNING id`;
      const organizationId = organization!.id;
      await tx`
        INSERT INTO organization_entitlements(organization_id,plan_id,trial_started_at,trial_ends_at,trial_status)
        VALUES(${organizationId}::uuid,${input.planId}::uuid,
          ${activateNow && input.trialDays ? new Date().toISOString() : null}::timestamptz,
          ${activateNow && input.trialDays ? new Date(Date.now() + input.trialDays * 86_400_000).toISOString() : null}::timestamptz,
          ${activateNow && input.trialDays ? "active" : "inactive"})`;

      let owner: {
        userId: string;
        created: boolean;
        password?: string;
      } | null = null;
      if (input.ownerEmail) {
        const [existing] = await tx<Array<{ id: string }>>`
          SELECT id FROM users WHERE lower(email)=${input.ownerEmail}`;
        if (existing) {
          await tx`
            INSERT INTO organization_members(organization_id,user_id,role)
            VALUES(${organizationId}::uuid,${existing.id}::uuid,'owner')
            ON CONFLICT DO NOTHING`;
          owner = { userId: existing.id, created: false };
        } else {
          if (!input.ownerPassword || !input.ownerPasswordHash)
            throw new Error("owner_credentials_required");
          const fullName =
            input.ownerFullName ?? input.ownerEmail.split("@")[0]!;
          const [created] = await tx<Array<{ id: string }>>`
            INSERT INTO users(email,password_hash,full_name,email_verified_at)
            VALUES(${input.ownerEmail},${input.ownerPasswordHash},${fullName},now())
            RETURNING id`;
          await tx`INSERT INTO user_credentials(user_id,password_hash) VALUES(${created!.id}::uuid,${input.ownerPasswordHash})`;
          await tx`
            INSERT INTO organization_members(organization_id,user_id,role)
            VALUES(${organizationId}::uuid,${created!.id}::uuid,'owner')`;
          await tx`
            INSERT INTO onboarding_progress(user_id,organization_id,current_step,completed_at)
            VALUES(${created!.id}::uuid,${organizationId}::uuid,10,now())`;
          owner = {
            userId: created!.id,
            created: true,
            password: input.ownerPassword,
          };
        }
      }
      await tx`
        INSERT INTO tenant_provisioning_audit(organization_id,action,actor,details)
        VALUES(${organizationId}::uuid,'create',${input.actorId},
          ${tx.json({ planCode: input.planCode, trialDays: input.trialDays, activateNow, ownerEmail: input.ownerEmail ?? null, source: "platform_admin_panel" } as never)})`;
      return { organizationId, owner };
    }) as Promise<{
      organizationId: string;
      owner: { userId: string; created: boolean; password?: string } | null;
    }>;
  }

  listPlans() {
    return this.sql<Row[]>`
      SELECT id,code,display_name,active FROM plans WHERE active=true ORDER BY display_name`;
  }

  async organizationDetails(organizationId: string) {
    const [organization] = await this.sql<Row[]>`
      SELECT o.id,o.name,o.slug,o.industry,o.timezone,o.default_locale,
        o.operational_status,o.activation_status,o.status_reason,
        o.activation_requested_at,o.activated_at,o.disabled_at,o.created_at,
        p.code plan_code,p.display_name plan_name,
        e.trial_status,e.trial_ends_at,e.grace_ends_at
      FROM organizations o
      LEFT JOIN organization_entitlements e ON e.organization_id=o.id
      LEFT JOIN plans p ON p.id=e.plan_id
      WHERE o.id=${organizationId}::uuid`;
    if (!organization) return null;
    const [usage, audit, owners] = await Promise.all([
      this.usage(organizationId, 60),
      this.sql<Row[]>`
        SELECT a.action,a.actor,a.details,a.reason,a.severity,a.before_state,
          a.after_state,a.created_at,u.email actor_email
        FROM tenant_provisioning_audit a
        LEFT JOIN users u ON u.id::text=a.actor
        WHERE a.organization_id=${organizationId}::uuid
        ORDER BY a.created_at DESC LIMIT 30`,
      this.sql<Row[]>`
        SELECT u.id,u.email,u.full_name
        FROM organization_members m JOIN users u ON u.id=m.user_id
        WHERE m.organization_id=${organizationId}::uuid AND m.role='owner'
        ORDER BY m.created_at LIMIT 1`,
    ]);
    return { organization, usage, audit, owner: owners[0] ?? null };
  }

  async updateOrganization(input: {
    organizationId: string;
    actorId: string;
    name?: string;
    industry?: string;
    timezone?: string;
    defaultLocale?: string;
  }): Promise<boolean> {
    const rows = await this.sql<Array<{ id: string }>>`
      UPDATE organizations SET
        name=COALESCE(${input.name ?? null},name),
        industry=COALESCE(${input.industry ?? null},industry),
        timezone=COALESCE(${input.timezone ?? null},timezone),
        default_locale=COALESCE(${input.defaultLocale ?? null},default_locale),
        updated_at=now()
      WHERE id=${input.organizationId}::uuid RETURNING id`;
    if (!rows.length) return false;
    await this.audit(input.organizationId, "edit", input.actorId, {
      name: input.name,
      industry: input.industry,
      timezone: input.timezone,
      defaultLocale: input.defaultLocale,
      source: "platform_admin_panel",
    });
    return true;
  }

  listMembers(organizationId: string) {
    return this.sql<Row[]>`
      SELECT u.id,u.email,u.full_name,m.role,m.created_at joined_at
      FROM organization_members m JOIN users u ON u.id=m.user_id
      WHERE m.organization_id=${organizationId}::uuid
      ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1
        WHEN 'team_lead' THEN 2 WHEN 'agent' THEN 3 ELSE 4 END,u.full_name`;
  }

  async memberGuard(organizationId: string, userId: string) {
    const [member] = await this.sql<Array<{ role: string }>>`
      SELECT role FROM organization_members
      WHERE organization_id=${organizationId}::uuid AND user_id=${userId}::uuid`;
    if (!member) return null;
    const [owners] = await this.sql<Array<{ count: number }>>`
      SELECT count(*)::int count FROM organization_members
      WHERE organization_id=${organizationId}::uuid AND role='owner'
        AND user_id<>${userId}::uuid`;
    return { role: member.role, otherOwnerCount: owners!.count };
  }

  async updateMemberRole(input: {
    organizationId: string;
    userId: string;
    role: string;
    actorId: string;
  }) {
    await this.sql`
      UPDATE organization_members SET role=${input.role},updated_at=now()
      WHERE organization_id=${input.organizationId}::uuid AND user_id=${input.userId}::uuid`;
    await this.audit(
      input.organizationId,
      "member_role_change",
      input.actorId,
      {
        userId: input.userId,
        role: input.role,
        source: "platform_admin_panel",
      },
    );
  }

  async removeMember(input: {
    organizationId: string;
    userId: string;
    actorId: string;
  }) {
    await this.sql`
      DELETE FROM organization_members
      WHERE organization_id=${input.organizationId}::uuid AND user_id=${input.userId}::uuid`;
    await this.audit(input.organizationId, "member_removed", input.actorId, {
      userId: input.userId,
      source: "platform_admin_panel",
    });
  }

  usage(organizationId: string, limit = 100) {
    return this.sql<Row[]>`
      SELECT usage_date,metric,quantity FROM usage_daily_rollups
      WHERE organization_id=${organizationId}::uuid
      ORDER BY usage_date DESC,metric LIMIT ${limit}`;
  }

  async setOrganizationStatus(input: {
    organizationId: string;
    disabled: boolean;
    actorId: string;
    reason?: string;
  }): Promise<boolean> {
    return this.sql.begin(async (tx) => {
      const [before] = await tx<
        Row[]
      >`SELECT operational_status,activation_status,status_reason FROM organizations WHERE id=${input.organizationId}::uuid FOR UPDATE`;
      if (!before) return false;
      const next = input.disabled ? "disabled" : "active";
      await tx`UPDATE organizations SET operational_status=${next},activation_status=CASE WHEN ${input.disabled} THEN activation_status ELSE 'approved' END,status_reason=${input.reason ?? null},status_changed_at=now(),status_changed_by=${input.actorId}::uuid,disabled_at=${input.disabled ? new Date().toISOString() : null}::timestamptz,updated_at=now() WHERE id=${input.organizationId}::uuid`;
      if (input.disabled)
        await tx`UPDATE user_sessions SET revoked_at=COALESCE(revoked_at,now()),revoke_reason='organization_disabled' WHERE organization_id=${input.organizationId}::uuid AND revoked_at IS NULL`;
      await tx`INSERT INTO tenant_provisioning_audit(organization_id,action,actor,actor_user_id,target_type,target_id,reason,before_state,after_state,severity,details) VALUES(${input.organizationId}::uuid,${input.disabled ? "disable" : "enable"},${input.actorId},${input.actorId}::uuid,'organization',${input.organizationId}::uuid,${input.reason ?? null},${tx.json(before as never)},${tx.json({ operationalStatus: next } as never)},${input.disabled ? "warning" : "info"},${tx.json({ source: "platform_admin_panel" } as never)})`;
      return true;
    }) as Promise<boolean>;
  }

  async assignPlan(input: {
    organizationId: string;
    planCode: string;
    actorId: string;
  }): Promise<boolean> {
    return this.sql.begin(async (tx) => {
      const [before] = await tx<
        Row[]
      >`SELECT p.code plan_code FROM organization_entitlements e JOIN plans p ON p.id=e.plan_id WHERE e.organization_id=${input.organizationId}::uuid FOR UPDATE`;
      const rows = await tx<
        Array<{ organization_id: string }>
      >`UPDATE organization_entitlements e SET plan_id=p.id,updated_by=${input.actorId}::uuid,updated_at=now() FROM plans p WHERE e.organization_id=${input.organizationId}::uuid AND p.code=${input.planCode} AND p.active=true RETURNING e.organization_id`;
      if (!rows.length) return false;
      await tx`INSERT INTO tenant_provisioning_audit(organization_id,action,actor,actor_user_id,target_type,target_id,before_state,after_state,details) VALUES(${input.organizationId}::uuid,'assign_plan',${input.actorId},${input.actorId}::uuid,'subscription',${input.organizationId}::uuid,${tx.json((before ?? {}) as never)},${tx.json({ planCode: input.planCode } as never)},${tx.json({ source: "platform_admin_panel" } as never)})`;
      return true;
    }) as Promise<boolean>;
  }

  async resetPassword(input: {
    userId: string;
    passwordHash: string;
    actorId: string;
    actorEmail: string;
  }): Promise<{ email: string } | null> {
    const [user] = await this.sql<Array<{ email: string }>>`
      UPDATE users SET password_hash=${input.passwordHash},updated_at=now()
      WHERE id=${input.userId}::uuid RETURNING email`;
    if (!user) return null;
    await this.sql.begin(async (tx) => {
      await tx`
        UPDATE user_credentials SET password_hash=${input.passwordHash},updated_at=now()
        WHERE user_id=${input.userId}::uuid`;
      await tx`
        UPDATE user_sessions SET revoked_at=now(),revoke_reason='admin_password_reset'
        WHERE user_id=${input.userId}::uuid AND revoked_at IS NULL`;
      await tx`
        INSERT INTO user_security_events(user_id,event_type,metadata)
        VALUES(${input.userId}::uuid,'admin_password_reset',
          ${tx.json({ actorId: input.actorId, actorEmail: input.actorEmail } as never)})`;
    });
    return user;
  }

  async createPasswordReset(input: {
    userId: string;
    tokenHash: string;
    actorId: string;
    actorEmail: string;
  }): Promise<{ email: string } | null> {
    return this.sql.begin(async (tx) => {
      const users = await tx<Array<{ email: string }>>`
        SELECT email FROM users WHERE id=${input.userId}::uuid FOR UPDATE`;
      const user = users[0];
      if (!user) return null;
      await tx`UPDATE password_reset_tokens SET consumed_at=COALESCE(consumed_at,now()) WHERE user_id=${input.userId}::uuid AND consumed_at IS NULL`;
      await tx`INSERT INTO password_reset_tokens(user_id,token_hash,expires_at) VALUES(${input.userId}::uuid,${input.tokenHash},now()+interval '1 hour')`;
      await tx`INSERT INTO user_security_events(user_id,event_type,metadata) VALUES(${input.userId}::uuid,'admin_password_reset_requested',${tx.json({ actorId: input.actorId, actorEmail: input.actorEmail } as never)})`;
      return user;
    }) as Promise<{ email: string } | null>;
  }

  async approveOrganization(input: {
    organizationId: string;
    actorId: string;
    planCode: string;
    trialDays: number;
    requestId?: string;
    ipAddress?: string;
    userAgent?: string;
  }) {
    return this.sql.begin(async (tx) => {
      const organizations = await tx<Array<Row>>`
        SELECT id,name,operational_status,activation_status,status_reason
        FROM organizations WHERE id=${input.organizationId}::uuid FOR UPDATE`;
      const organization = organizations[0];
      if (!organization) return null;
      if (
        organization.operational_status === "active" &&
        organization.activation_status === "approved"
      )
        return { updated: false, idempotent: true };
      const plans = await tx<Array<{ id: string }>>`
        SELECT id FROM plans WHERE code=${input.planCode} AND active=true`;
      const plan = plans[0];
      if (!plan)
        throw Object.assign(new Error("invalid_plan"), { statusCode: 400 });
      const now = new Date();
      const trialEndsAt = new Date(
        now.getTime() + input.trialDays * 86_400_000,
      );
      await tx`
        INSERT INTO organization_entitlements(
          organization_id,plan_id,trial_started_at,trial_ends_at,trial_status,
          updated_by,updated_at
        ) VALUES(
          ${input.organizationId}::uuid,${plan.id}::uuid,${now.toISOString()}::timestamptz,${trialEndsAt.toISOString()}::timestamptz,
          ${input.trialDays > 0 ? "active" : "inactive"},${input.actorId}::uuid,now()
        ) ON CONFLICT(organization_id) DO UPDATE SET
          plan_id=EXCLUDED.plan_id,trial_started_at=EXCLUDED.trial_started_at,
          trial_ends_at=EXCLUDED.trial_ends_at,
          trial_status=EXCLUDED.trial_status,grace_ends_at=NULL,
          updated_by=EXCLUDED.updated_by,updated_at=now()`;
      await tx`UPDATE organizations SET operational_status='active',activation_status='approved',status_reason=NULL,activated_at=now(),activated_by=${input.actorId}::uuid,status_changed_at=now(),status_changed_by=${input.actorId}::uuid,disabled_at=NULL,updated_at=now() WHERE id=${input.organizationId}::uuid`;
      await tx`INSERT INTO tenant_provisioning_audit(
        organization_id,action,actor,actor_user_id,target_type,target_id,
        request_id,ip_address,user_agent,before_state,after_state,details
      ) VALUES(
        ${input.organizationId}::uuid,'approve',${input.actorId},${input.actorId}::uuid,
        'organization',${input.organizationId}::uuid,${input.requestId ?? null},
        ${input.ipAddress ?? null}::inet,${input.userAgent ?? null},
        ${JSON.stringify(organization)}::jsonb,
        ${JSON.stringify({ operationalStatus: "active", activationStatus: "approved", planCode: input.planCode, trialDays: input.trialDays })}::jsonb,
        ${JSON.stringify({ source: "platform_admin_panel" })}::jsonb)`;
      return { updated: true, idempotent: false, trialEndsAt };
    });
  }

  async rejectOrganization(input: {
    organizationId: string;
    actorId: string;
    reason: string;
    requestId?: string;
    ipAddress?: string;
    userAgent?: string;
  }) {
    return this.sql.begin(async (tx) => {
      const rows = await tx<Array<Row>>`
        SELECT id,operational_status,activation_status,status_reason
        FROM organizations WHERE id=${input.organizationId}::uuid FOR UPDATE`;
      const before = rows[0];
      if (!before) return null;
      await tx`UPDATE organizations SET operational_status='rejected',activation_status='rejected',status_reason=${input.reason},status_changed_at=now(),status_changed_by=${input.actorId}::uuid,disabled_at=now(),updated_at=now() WHERE id=${input.organizationId}::uuid`;
      await tx`UPDATE user_sessions SET revoked_at=COALESCE(revoked_at,now()),revoke_reason='organization_rejected' WHERE organization_id=${input.organizationId}::uuid AND revoked_at IS NULL`;
      await tx`INSERT INTO tenant_provisioning_audit(
        organization_id,action,actor,actor_user_id,target_type,target_id,
        request_id,ip_address,user_agent,reason,before_state,after_state,severity,details
      ) VALUES(
        ${input.organizationId}::uuid,'reject',${input.actorId},${input.actorId}::uuid,
        'organization',${input.organizationId}::uuid,${input.requestId ?? null},
        ${input.ipAddress ?? null}::inet,${input.userAgent ?? null},${input.reason},
        ${JSON.stringify(before)}::jsonb,
        ${JSON.stringify({ operationalStatus: "rejected", activationStatus: "rejected" })}::jsonb,
        'warning',${JSON.stringify({ source: "platform_admin_panel" })}::jsonb)`;
      return { updated: true };
    });
  }

  async listUsers(input: {
    term: string | null;
    status: string | null;
    organizationId: string | null;
    role: string | null;
    limit: number;
    offset: number;
  }) {
    const statusSql = this.sql.unsafe(`CASE
      WHEN u.suspended_at IS NOT NULL OR u.is_active=false THEN 'suspended'
      WHEN u.email_verified_at IS NULL THEN 'unverified'
      ELSE 'active' END`);
    const [rows, totals] = await Promise.all([
      this.sql<Row[]>`
        SELECT u.id,u.email,u.full_name,u.is_active,u.suspended_at,
          u.email_verified_at,u.last_login_at,u.created_at,u.is_platform_admin,
          ${statusSql} status,
          COALESCE(jsonb_agg(jsonb_build_object(
            'organizationId',o.id,'organizationName',o.name,'role',m.role
          ) ORDER BY o.name) FILTER(WHERE o.id IS NOT NULL),'[]'::jsonb) memberships
        FROM users u
        LEFT JOIN organization_members m ON m.user_id=u.id
        LEFT JOIN organizations o ON o.id=m.organization_id
        WHERE (${input.term}::text IS NULL OR u.email ILIKE ${input.term} OR u.full_name ILIKE ${input.term})
          AND (${input.status}::text IS NULL OR (${statusSql})=${input.status})
          AND (${input.organizationId}::uuid IS NULL OR m.organization_id=${input.organizationId}::uuid)
          AND (${input.role}::text IS NULL OR m.role::text=${input.role})
        GROUP BY u.id
        ORDER BY u.created_at DESC,u.id
        LIMIT ${input.limit} OFFSET ${input.offset}`,
      this.sql<Array<{ count: number }>>`
        SELECT count(DISTINCT u.id)::int count FROM users u
        LEFT JOIN organization_members m ON m.user_id=u.id
        WHERE (${input.term}::text IS NULL OR u.email ILIKE ${input.term} OR u.full_name ILIKE ${input.term})
          AND (${input.status}::text IS NULL OR (${statusSql})=${input.status})
          AND (${input.organizationId}::uuid IS NULL OR m.organization_id=${input.organizationId}::uuid)
          AND (${input.role}::text IS NULL OR m.role::text=${input.role})`,
    ]);
    return { rows, total: totals[0]?.count ?? 0 };
  }

  async setUserStatus(input: {
    userId: string;
    actorId: string;
    status: "active" | "suspended";
    reason?: string;
  }) {
    return this.sql.begin(async (tx) => {
      if (input.userId === input.actorId && input.status === "suspended")
        throw Object.assign(new Error("self_suspend_forbidden"), {
          statusCode: 400,
        });
      const users = await tx<Array<Row>>`
        SELECT id,email,is_active,suspended_at FROM users
        WHERE id=${input.userId}::uuid FOR UPDATE`;
      const before = users[0];
      if (!before) return null;
      if (input.status === "suspended") {
        const unsupported = await tx<Array<{ organization_id: string }>>`
          SELECT membership.organization_id
          FROM organization_members membership
          WHERE membership.user_id=${input.userId}::uuid
            AND membership.role='owner'
            AND NOT EXISTS(
              SELECT 1 FROM organization_members other
              JOIN users candidate ON candidate.id=other.user_id
              WHERE other.organization_id=membership.organization_id
                AND other.role='owner' AND other.user_id<>membership.user_id
                AND candidate.is_active=true AND candidate.suspended_at IS NULL
            )`;
        if (unsupported.length)
          throw Object.assign(new Error("last_owner_required"), {
            statusCode: 409,
          });
      }
      const active = input.status === "active";
      await tx`UPDATE users SET is_active=${active},suspended_at=${active ? null : new Date().toISOString()}::timestamptz,updated_at=now() WHERE id=${input.userId}::uuid`;
      if (!active)
        await tx`UPDATE user_sessions SET revoked_at=COALESCE(revoked_at,now()),revoke_reason='platform_admin_suspended' WHERE user_id=${input.userId}::uuid AND revoked_at IS NULL`;
      const memberships = await tx<Array<{ organization_id: string }>>`
        SELECT organization_id FROM organization_members WHERE user_id=${input.userId}::uuid`;
      for (const membership of memberships)
        await tx`INSERT INTO tenant_provisioning_audit(
          organization_id,action,actor,actor_user_id,target_type,target_id,reason,
          before_state,after_state,severity,details
        ) VALUES(
          ${membership.organization_id}::uuid,${active ? "user_activate" : "user_suspend"},
          ${input.actorId},${input.actorId}::uuid,'user',${input.userId}::uuid,
          ${input.reason ?? null},${tx.json(before as never)},
          ${tx.json({ status: input.status } as never)},
          ${active ? "info" : "warning"},${tx.json({ source: "platform_admin_panel" } as never)})`;
      return { updated: true, status: input.status };
    });
  }

  async platformOverview(windowDays: 7 | 30) {
    const [
      organizations,
      users,
      channels,
      integrations,
      campaigns,
      billing,
      trends,
      usage,
      alerts,
      workers,
      queues,
    ] = await Promise.all([
      this.sql<Row[]>`
          SELECT count(*)::int total,
            count(*) FILTER(WHERE operational_status='pending_review')::int pending_review,
            count(*) FILTER(WHERE operational_status='active')::int active,
            count(*) FILTER(WHERE operational_status='disabled')::int disabled,
            count(*) FILTER(WHERE operational_status='rejected')::int rejected,
            count(*) FILTER(WHERE activation_status='pending' AND activation_requested_at<now()-interval '24 hours')::int overdue_approvals
          FROM organizations`,
      this.sql<Row[]>`
          SELECT count(*)::int total,
            count(*) FILTER(WHERE is_active=true AND suspended_at IS NULL)::int active,
            count(*) FILTER(WHERE suspended_at IS NOT NULL OR is_active=false)::int suspended,
            count(*) FILTER(WHERE last_login_at>=now()-interval '30 days')::int recently_active
          FROM users`,
      this.sql<Row[]>`
          SELECT count(*)::int total,
            count(*) FILTER(WHERE connection_status IN ('ACTIVE','CONNECTED') AND health_state='HEALTHY')::int healthy,
            count(*) FILTER(WHERE connection_status IN ('DISCONNECTED','ERROR') OR health_state IN ('UNHEALTHY','CRITICAL'))::int critical,
            count(*) FILTER(WHERE health_state IN ('UNKNOWN','DEGRADED'))::int attention
          FROM channels WHERE deleted_at IS NULL`,
      this.sql<Row[]>`
          SELECT count(*)::int total,
            count(*) FILTER(WHERE status='connected')::int connected,
            count(*) FILTER(WHERE status='error')::int failed,
            count(*) FILTER(WHERE status IN ('degraded','disconnected','warning'))::int attention
          FROM integration_connections`,
      this.sql<Row[]>`
          SELECT count(DISTINCT campaign.id)::int total,
            count(recipient.id) FILTER(WHERE recipient.status='failed')::int failed_recipients,
            count(recipient.id)::int recipients
          FROM campaigns campaign
          LEFT JOIN campaign_recipients recipient ON recipient.campaign_id=campaign.id
          WHERE campaign.created_at>=now()-(${windowDays}::text||' days')::interval`,
      this.sql<Row[]>`
          SELECT count(*) FILTER(WHERE status IN ('past_due','failed'))::int payment_attention,
            (SELECT count(*)::int FROM billing_webhook_events WHERE status='failed') failed_webhooks,
            (SELECT count(*)::int FROM billing_sales_requests WHERE status='pending') pending_line_requests,
            (SELECT count(*)::int FROM organization_entitlements WHERE trial_status='active' AND trial_ends_at BETWEEN now() AND now()+interval '3 days') trials_ending
          FROM organization_subscriptions`,
      this.sql<Row[]>`
          SELECT series::date AS "day",
            (SELECT count(*)::int FROM organizations o WHERE o.created_at>=series AND o.created_at<series+interval '1 day') new_organizations,
            (SELECT count(*)::int FROM users u WHERE u.last_login_at>=series AND u.last_login_at<series+interval '1 day') active_users
          FROM generate_series(
            (current_date-${windowDays - 1}::int)::timestamptz,
            current_date::timestamptz,interval '1 day'
          ) series ORDER BY series`,
      this.sql<Row[]>`
          SELECT metric,sum(quantity)::bigint quantity FROM usage_daily_rollups
          WHERE usage_date>=(current_date-${windowDays - 1}::int) GROUP BY metric ORDER BY metric`,
      this.sql<Row[]>`
          SELECT count(*) FILTER(WHERE status IN ('open','acknowledged'))::int open,
            count(*) FILTER(WHERE status IN ('open','acknowledged') AND severity='critical')::int critical,
            count(*) FILTER(WHERE status IN ('open','acknowledged') AND severity='warning')::int warning
          FROM platform_alerts`,
      this.sql<Row[]>`
          SELECT service,instance_id,version,started_at,last_heartbeat,current_jobs,
            processed_count,failed_count,status,
            (last_heartbeat<now()-interval '60 seconds') stale
          FROM (
            SELECT DISTINCT ON(service) * FROM worker_instances
            ORDER BY service,last_heartbeat DESC
          ) current_workers ORDER BY service`,
      this.queueSummary(null),
    ]);
    return {
      windowDays,
      organizations: organizations[0] ?? {},
      users: users[0] ?? {},
      channels: channels[0] ?? {},
      integrations: integrations[0] ?? {},
      campaigns: campaigns[0] ?? {},
      billing: billing[0] ?? {},
      alerts: alerts[0] ?? {},
      trends,
      usage,
      workers,
      queues,
    };
  }

  operations() {
    return Promise.all([
      this.queueSummary(null),
      this.sql<Row[]>`
        SELECT service,instance_id,version,started_at,last_heartbeat,current_jobs,
          processed_count,failed_count,status,
          (last_heartbeat<now()-interval '60 seconds') stale
        FROM (
          SELECT DISTINCT ON(service) * FROM worker_instances
          ORDER BY service,last_heartbeat DESC
        ) current_workers ORDER BY service`,
      this.sql<Row[]>`
        SELECT provider,status,count(*)::int count,max(last_health_at) last_health_at
        FROM integration_connections GROUP BY provider,status ORDER BY provider,status`,
    ]).then(([queues, workers, integrations]) => ({
      queues,
      workers,
      integrations,
    }));
  }

  async billingOverview() {
    const [summary, subscriptions, transactions, salesRequests] =
      await Promise.all([
        this.sql<Row[]>`
          SELECT
            count(*) FILTER(WHERE status IN('active','trialing','manual','legacy_free'))::int active_subscriptions,
            count(*) FILTER(WHERE status IN('past_due','failed'))::int payment_attention,
            (SELECT count(*)::int FROM billing_transactions WHERE created_at>=now()-interval '30 days') transactions_30d,
            (SELECT count(*)::int FROM billing_sales_requests WHERE status='pending') pending_sales_requests
          FROM organization_subscriptions`,
        this.sql<Row[]>`
          SELECT subscription.id,organization.id organization_id,
            organization.name organization_name,subscription.provider,
            subscription.plan_code,subscription.status,
            subscription.current_period_start,subscription.current_period_end,
            subscription.grace_ends_at,subscription.cancel_at_period_end
          FROM organization_subscriptions subscription
          JOIN organizations organization ON organization.id=subscription.organization_id
          ORDER BY subscription.updated_at DESC LIMIT 200`,
        this.sql<Row[]>`
          SELECT transaction.id,organization.name organization_name,
            transaction.provider,transaction.status,transaction.currency,
            transaction.subtotal_minor,transaction.tax_minor,
            transaction.total_minor,transaction.billed_at,transaction.created_at
          FROM billing_transactions transaction
          JOIN organizations organization ON organization.id=transaction.organization_id
          ORDER BY transaction.created_at DESC LIMIT 200`,
        this.sql<Row[]>`
          SELECT request.id,organization.name organization_name,
            product.name product_name,request.quantity,request.status,
            request.created_at,request.reviewed_at
          FROM billing_sales_requests request
          JOIN organizations organization ON organization.id=request.organization_id
          JOIN billing_products product ON product.id=request.product_id
          ORDER BY request.created_at DESC LIMIT 200`,
      ]);
    return {
      summary: summary[0] ?? {},
      subscriptions,
      transactions,
      salesRequests,
    };
  }

  async organizationOperations(organizationId: string) {
    const organizations = await this.sql<Row[]>`
      SELECT id FROM organizations WHERE id=${organizationId}::uuid`;
    if (!organizations[0]) return null;
    const [
      channels,
      integrations,
      campaigns,
      automations,
      ai,
      storage,
      usage,
      queues,
    ] = await Promise.all([
      this.sql<
        Row[]
      >`SELECT provider,connection_status,health_state,count(*)::int count,max(health_checked_at) last_health_at FROM channels WHERE organization_id=${organizationId}::uuid AND deleted_at IS NULL GROUP BY provider,connection_status,health_state ORDER BY provider`,
      this.sql<
        Row[]
      >`SELECT provider,status,last_health_at,last_sync_at,last_error_code FROM integration_connections WHERE organization_id=${organizationId}::uuid ORDER BY provider,created_at`,
      this.sql<
        Row[]
      >`SELECT count(DISTINCT c.id)::int campaigns,count(r.id)::int recipients,count(r.id) FILTER(WHERE r.status='failed')::int failed_recipients,max(c.created_at) last_campaign_at FROM campaigns c LEFT JOIN campaign_recipients r ON r.campaign_id=c.id WHERE c.organization_id=${organizationId}::uuid AND c.created_at>=now()-interval '30 days'`,
      this.sql<
        Row[]
      >`SELECT status,count(*)::int count,max(started_at) last_run_at FROM automation_runs WHERE organization_id=${organizationId}::uuid AND started_at>=now()-interval '30 days' GROUP BY status ORDER BY status`,
      this.sql<
        Row[]
      >`SELECT status,count(*)::int count,max(started_at) last_run_at,coalesce(sum(total_cost_usd),0) cost_usd FROM ai_runs WHERE organization_id=${organizationId}::uuid AND started_at>=now()-interval '30 days' GROUP BY status ORDER BY status`,
      this.sql<
        Row[]
      >`SELECT provider,status,last_health_check_at,last_error_code FROM storage_connections WHERE organization_id=${organizationId}::uuid ORDER BY created_at`,
      this.sql<
        Row[]
      >`SELECT usage_date,metric,quantity FROM usage_daily_rollups WHERE organization_id=${organizationId}::uuid AND usage_date>=current_date-30 ORDER BY usage_date DESC,metric`,
      this.queueSummary(organizationId),
    ]);
    return {
      channels,
      integrations,
      campaigns: campaigns[0] ?? {},
      automations,
      ai,
      storage,
      usage,
      queues,
    };
  }

  async listAlerts(input: {
    status: string | null;
    severity: string | null;
    category: string | null;
    organizationId: string | null;
    limit: number;
    offset: number;
  }) {
    const [rows, totals] = await Promise.all([
      this.sql<Row[]>`
        SELECT alert.id,alert.category,alert.severity,alert.organization_id,
          organization.name organization_name,alert.status,alert.title,
          alert.message,alert.safe_metadata,alert.first_seen_at,
          alert.last_seen_at,alert.acknowledged_at,alert.resolved_at
        FROM platform_alerts alert
        LEFT JOIN organizations organization ON organization.id=alert.organization_id
        WHERE (${input.status}::text IS NULL OR alert.status=${input.status})
          AND (${input.severity}::text IS NULL OR alert.severity=${input.severity})
          AND (${input.category}::text IS NULL OR alert.category=${input.category})
          AND (${input.organizationId}::uuid IS NULL OR alert.organization_id=${input.organizationId}::uuid)
        ORDER BY CASE alert.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,alert.last_seen_at DESC
        LIMIT ${input.limit} OFFSET ${input.offset}`,
      this.sql<Array<{ count: number }>>`
        SELECT count(*)::int count FROM platform_alerts alert
        WHERE (${input.status}::text IS NULL OR alert.status=${input.status})
          AND (${input.severity}::text IS NULL OR alert.severity=${input.severity})
          AND (${input.category}::text IS NULL OR alert.category=${input.category})
          AND (${input.organizationId}::uuid IS NULL OR alert.organization_id=${input.organizationId}::uuid)`,
    ]);
    return { rows, total: totals[0]?.count ?? 0 };
  }

  async acknowledgeAlert(alertId: string, actorId: string) {
    const rows = await this.sql<Array<{ id: string }>>`
      UPDATE platform_alerts SET status='acknowledged',acknowledged_at=now(),
        acknowledged_by=${actorId}::uuid,updated_at=now()
      WHERE id=${alertId}::uuid AND status='open' RETURNING id`;
    return Boolean(rows[0]);
  }

  private queueSummary(organizationId: string | null) {
    return this.sql<Row[]>`
      WITH queue_rows AS (
        SELECT 'outbox' queue,status,created_at FROM outbox_jobs WHERE (${organizationId}::uuid IS NULL OR organization_id=${organizationId}::uuid)
        UNION ALL SELECT 'media',status,created_at FROM media_processing_jobs WHERE (${organizationId}::uuid IS NULL OR organization_id=${organizationId}::uuid)
        UNION ALL SELECT 'files',status,created_at FROM file_processing_jobs WHERE (${organizationId}::uuid IS NULL OR organization_id=${organizationId}::uuid)
        UNION ALL SELECT 'crm',status,created_at FROM crm_sync_jobs WHERE (${organizationId}::uuid IS NULL OR organization_id=${organizationId}::uuid)
        UNION ALL SELECT 'automation',status,created_at FROM automation_events WHERE (${organizationId}::uuid IS NULL OR organization_id=${organizationId}::uuid)
        UNION ALL SELECT 'open_channels',status,created_at FROM bitrix_open_channel_jobs WHERE (${organizationId}::uuid IS NULL OR organization_id=${organizationId}::uuid)
      )
      SELECT queue,
        count(*) FILTER(WHERE status IN ('pending','queued','retry','processing'))::int active,
        count(*) FILTER(WHERE status='retry')::int retry,
        count(*) FILTER(WHERE status IN ('failed','dead_letter','blocked','manual_review'))::int failed,
        min(created_at) FILTER(WHERE status IN ('pending','queued','retry','processing')) oldest_active_at
      FROM queue_rows GROUP BY queue ORDER BY queue`;
  }

  async auditLog(input: {
    limit: number;
    offset: number;
    organizationId?: string | null;
    actorId?: string | null;
    action?: string | null;
    severity?: string | null;
    createdFrom?: Date | null;
    createdTo?: Date | null;
  }) {
    const createdFrom = input.createdFrom?.toISOString() ?? null;
    const createdTo = input.createdTo?.toISOString() ?? null;
    const [rows, totals] = await Promise.all([
      this.sql<Row[]>`
        SELECT a.id,a.action,a.actor,a.details,a.created_at,
          u.email actor_email,o.id organization_id,o.name organization_name,o.slug organization_slug
        FROM tenant_provisioning_audit a
        LEFT JOIN users u ON u.id::text=a.actor
        LEFT JOIN organizations o ON o.id=a.organization_id
        WHERE (${input.organizationId ?? null}::uuid IS NULL OR a.organization_id=${input.organizationId ?? null}::uuid)
          AND (${input.actorId ?? null}::uuid IS NULL OR a.actor_user_id=${input.actorId ?? null}::uuid OR a.actor=${input.actorId ?? null})
          AND (${input.action ?? null}::text IS NULL OR a.action=${input.action ?? null})
          AND (${input.severity ?? null}::text IS NULL OR a.severity=${input.severity ?? null})
          AND (${createdFrom}::timestamptz IS NULL OR a.created_at>=${createdFrom}::timestamptz)
          AND (${createdTo}::timestamptz IS NULL OR a.created_at<${createdTo}::timestamptz)
        ORDER BY a.created_at DESC LIMIT ${input.limit} OFFSET ${input.offset}`,
      this.sql<Array<{ count: number }>>`
        SELECT count(*)::int count FROM tenant_provisioning_audit a
        WHERE (${input.organizationId ?? null}::uuid IS NULL OR a.organization_id=${input.organizationId ?? null}::uuid)
          AND (${input.actorId ?? null}::uuid IS NULL OR a.actor_user_id=${input.actorId ?? null}::uuid OR a.actor=${input.actorId ?? null})
          AND (${input.action ?? null}::text IS NULL OR a.action=${input.action ?? null})
          AND (${input.severity ?? null}::text IS NULL OR a.severity=${input.severity ?? null})
          AND (${createdFrom}::timestamptz IS NULL OR a.created_at>=${createdFrom}::timestamptz)
          AND (${createdTo}::timestamptz IS NULL OR a.created_at<${createdTo}::timestamptz)`,
    ]);
    return { rows, total: totals[0]!.count };
  }

  listAdmins() {
    return this.sql<Row[]>`
      SELECT id,email,full_name,last_login_at FROM users
      WHERE is_platform_admin=true ORDER BY email`;
  }

  async setPlatformAdmin(input: {
    userId?: string;
    email?: string;
    enabled: boolean;
    actorId: string;
    actorEmail: string;
  }): Promise<{ id: string; email: string } | null> {
    const rows = input.userId
      ? await this.sql<Array<{ id: string; email: string }>>`
          UPDATE users SET is_platform_admin=${input.enabled},updated_at=now()
          WHERE id=${input.userId}::uuid RETURNING id,email`
      : await this.sql<Array<{ id: string; email: string }>>`
          UPDATE users SET is_platform_admin=${input.enabled},updated_at=now()
          WHERE lower(email)=${input.email!} RETURNING id,email`;
    const user = rows[0];
    if (!user) return null;
    await this.sql`
      INSERT INTO user_security_events(user_id,event_type,metadata)
      VALUES(${user.id}::uuid,${input.enabled ? "platform_admin_granted" : "platform_admin_revoked"},
        ${this.sql.json({ actorId: input.actorId, actorEmail: input.actorEmail } as never)})`;
    return user;
  }

  private async audit(
    organizationId: string,
    action: string,
    actorId: string,
    details: Record<string, unknown>,
  ) {
    await this.sql`
      INSERT INTO tenant_provisioning_audit(organization_id,action,actor,actor_user_id,target_type,target_id,details)
      VALUES(${organizationId}::uuid,${action},${actorId},${actorId}::uuid,'organization',${organizationId}::uuid,${this.sql.json(details as never)})`;
  }
}
