import type postgres from "postgres";

type Sql = ReturnType<typeof postgres>;

export type AuthWorkspace = {
  id: string;
  name: string;
  slug: string;
  role: string;
  active: boolean;
};

export type SwitchedWorkspace = {
  userId: string;
  email: string;
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  role: string;
};

export class AuthWorkspaceRepository {
  constructor(private readonly sql: Sql) {}

  async list(userId: string, currentOrganizationId: string) {
    return this.sql<AuthWorkspace[]>`
      SELECT o.id,o.name,o.slug,om.role,
        (o.id=${currentOrganizationId}::uuid) active
      FROM organization_members om
      JOIN organizations o ON o.id=om.organization_id
      WHERE om.user_id=${userId}::uuid
      ORDER BY om.created_at,o.name`;
  }

  async switchCurrentSession(input: {
    userId: string;
    targetOrganizationId: string;
    currentOrganizationId: string;
    refreshTokenHash: string;
    ipAddress: string;
    userAgent?: string;
  }): Promise<SwitchedWorkspace | null> {
    return this.sql.begin(async (tx) => {
      const memberships = await tx<
        Array<{
          user_id: string;
          email: string;
          organization_id: string;
          organization_name: string;
          organization_slug: string;
          role: string;
        }>
      >`
        SELECT u.id user_id,u.email,om.organization_id,
          o.name organization_name,o.slug organization_slug,om.role
        FROM users u
        JOIN organization_members om ON om.user_id=u.id
        JOIN organizations o ON o.id=om.organization_id
        WHERE u.id=${input.userId}::uuid
          AND om.organization_id=${input.targetOrganizationId}::uuid
          AND u.is_active=true
          AND u.suspended_at IS NULL
        FOR UPDATE OF om`;
      const membership = memberships[0];
      if (!membership) return null;
      const sessions = await tx<Array<{ id: string }>>`
        UPDATE user_sessions
        SET organization_id=${input.targetOrganizationId}::uuid,last_seen_at=now()
        WHERE token_hash=${input.refreshTokenHash}
          AND user_id=${input.userId}::uuid
          AND revoked_at IS NULL
          AND expires_at>now()
        RETURNING id`;
      if (!sessions[0]) return null;
      await tx`
        INSERT INTO user_security_events(
          user_id,organization_id,event_type,metadata,ip_address,user_agent
        ) VALUES(
          ${input.userId}::uuid,${input.targetOrganizationId}::uuid,
          'auth.workspace_switched',
          ${tx.json({ fromOrganizationId: input.currentOrganizationId } as never)},
          ${input.ipAddress}::inet,${input.userAgent ?? null}
        )`;
      return {
        userId: membership.user_id,
        email: membership.email,
        organizationId: membership.organization_id,
        organizationName: membership.organization_name,
        organizationSlug: membership.organization_slug,
        role: membership.role,
      };
    });
  }
}
