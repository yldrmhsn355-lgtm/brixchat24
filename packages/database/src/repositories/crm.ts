import type postgres from "postgres";
import type { TransactionSql } from "postgres";

type DatabaseClient = ReturnType<typeof postgres>;

export type CrmUserMappingInput = {
  externalUserId: string;
  localUserId: string | null;
  externalSnapshot: Record<string, unknown>;
  active: boolean;
  crmPolicy: {
    mode: "inherit" | "disabled" | "lead" | "contact_and_deal";
    sourceId?: string | undefined;
  };
};

/** Database gateway for CRM route persistence. */
export class CrmRepository {
  constructor(private readonly client: DatabaseClient) {}

  async hasActiveBitrixMarketInstallation(
    transaction: TransactionSql,
    memberId: string,
  ): Promise<boolean> {
    await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${`bitrix_market_install:${memberId}`},0))`;
    const rows = await transaction<Array<{ id: string }>>`
      SELECT id
      FROM integration_connections
      WHERE provider='bitrix24'
        AND member_id=${memberId}
        AND status<>'disconnected'
      LIMIT 1
    `;
    return Boolean(rows[0]);
  }

  async connection(
    organizationId: string,
    id?: string,
  ): Promise<Record<string, unknown> | null> {
    const rows = await this.client<Array<Record<string, unknown>>>`
      SELECT * FROM integration_connections
      WHERE organization_id=${organizationId}::uuid
        AND (${id ?? null}::text IS NULL OR id::text=${id ?? null})
      ORDER BY created_at LIMIT 1`;
    return rows[0] ?? null;
  }

  listUserMappings(organizationId: string, connectionId: string) {
    return this.client<Array<Record<string, unknown>>>`
      SELECT m.*,u.full_name local_user_name,u.email local_user_email
      FROM crm_user_mappings m LEFT JOIN users u ON u.id=m.local_user_id
      WHERE m.organization_id=${organizationId}::uuid
        AND m.connection_id=${connectionId}::uuid
      ORDER BY (m.external_snapshot->>'name')`;
  }

  async replaceUserMappings(
    organizationId: string,
    connectionId: string,
    mappings: CrmUserMappingInput[],
  ): Promise<number> {
    return this.client.begin(async (transaction) => {
      const connections = await transaction<Array<{ id: string }>>`
        SELECT id
        FROM integration_connections
        WHERE id=${connectionId}::uuid
          AND organization_id=${organizationId}::uuid
          AND provider='bitrix24'
        FOR UPDATE`;
      if (!connections[0])
        throw Object.assign(new Error("integration_not_found"), {
          statusCode: 404,
        });

      const localUserIds = mappings.flatMap((mapping) =>
        mapping.localUserId ? [mapping.localUserId] : [],
      );
      if (localUserIds.length > 0) {
        const validUsers = await transaction<Array<{ count: number }>>`
          SELECT count(DISTINCT member.user_id)::int count
          FROM organization_members member
          JOIN users user_account
            ON user_account.id=member.user_id
           AND user_account.is_active=true
           AND user_account.suspended_at IS NULL
          WHERE member.organization_id=${organizationId}::uuid
            AND member.user_id=ANY(${localUserIds}::uuid[])`;
        if ((validUsers[0]?.count ?? 0) !== localUserIds.length)
          throw Object.assign(new Error("mapping_local_user_invalid"), {
            statusCode: 409,
          });
      }

      const externalUserIds = mappings.map((mapping) => mapping.externalUserId);
      if (externalUserIds.length > 0)
        await transaction`
          UPDATE crm_user_mappings
          SET local_user_id=NULL,updated_at=now()
          WHERE organization_id=${organizationId}::uuid
            AND connection_id=${connectionId}::uuid
            AND external_user_id=ANY(${externalUserIds}::text[])`;

      for (const mapping of mappings)
        await transaction`
          INSERT INTO crm_user_mappings(
            organization_id,connection_id,local_user_id,external_user_id,
            external_snapshot,active,crm_policy
          ) VALUES(
            ${organizationId}::uuid,${connectionId}::uuid,
            ${mapping.localUserId}::uuid,${mapping.externalUserId},
            ${transaction.json(mapping.externalSnapshot as never)},
            ${mapping.active},
            ${transaction.json(mapping.crmPolicy as never)}
          )
          ON CONFLICT(connection_id,external_user_id) DO UPDATE SET
            local_user_id=EXCLUDED.local_user_id,
            external_snapshot=EXCLUDED.external_snapshot,
            active=EXCLUDED.active,
            crm_policy=EXCLUDED.crm_policy,
            updated_at=now()`;
      return mappings.length;
    }) as unknown as Promise<number>;
  }

  listPipelines(organizationId: string, connectionId: string) {
    return this.client<Array<Record<string, unknown>>>`
      SELECT * FROM crm_pipeline_cache
      WHERE organization_id=${organizationId}::uuid
        AND connection_id=${connectionId}::uuid
      ORDER BY pipeline_name,stage_order`;
  }

  listSyncJobs(organizationId: string, connectionId: string) {
    return this.client<Array<Record<string, unknown>>>`
      SELECT id,job_type,aggregate_type,aggregate_id,status,attempt_count,
        max_attempts,next_attempt_at,last_error_code,completed_at,created_at
      FROM crm_sync_jobs
      WHERE organization_id=${organizationId}::uuid
        AND connection_id=${connectionId}::uuid
      ORDER BY created_at DESC LIMIT 100`;
  }

  listSyncLogs(organizationId: string, connectionId: string) {
    return this.client<Array<Record<string, unknown>>>`
      SELECT id,job_id,level,operation,message,details,duration_ms,created_at
      FROM crm_sync_logs
      WHERE organization_id=${organizationId}::uuid
        AND connection_id=${connectionId}::uuid
      ORDER BY created_at DESC LIMIT 200`;
  }

  async query<T = Array<Record<string, unknown>>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T> {
    return (await this.client(strings, ...(values as never[]))) as unknown as T;
  }

  begin<T>(callback: (transaction: TransactionSql) => Promise<T>): Promise<T> {
    return this.client.begin(callback as never) as unknown as Promise<T>;
  }
}
