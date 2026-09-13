import { createHash } from "node:crypto";
import nodemailer from "nodemailer";
import type postgres from "postgres";

type Sql = ReturnType<typeof postgres>;
type Row = Record<string, unknown>;
export type AlertCandidate = {
  fingerprint: string;
  category: string;
  severity: "info" | "warning" | "critical";
  organizationId: string | null;
  title: string;
  message: string;
  metadata: Record<string, unknown>;
};

export const platformAlertFingerprint = (
  category: string,
  organizationId: string | null,
  key: string,
) =>
  createHash("sha256")
    .update(`${category}:${organizationId ?? "platform"}:${key}`)
    .digest("hex");
const candidate = (
  input: Omit<AlertCandidate, "fingerprint"> & { key: string },
): AlertCandidate => ({
  ...input,
  fingerprint: platformAlertFingerprint(
    input.category,
    input.organizationId,
    input.key,
  ),
});

export async function collectPlatformAlerts(
  sql: Sql,
): Promise<AlertCandidate[]> {
  const [workers, queues, connections, billing, trials, approvals] =
    await Promise.all([
      sql<Row[]>`SELECT service,instance_id,last_heartbeat
        FROM (
          SELECT DISTINCT ON(service) service,instance_id,last_heartbeat,status
          FROM worker_instances
          ORDER BY service,last_heartbeat DESC
        ) current_workers
        WHERE status<>'stopped' AND last_heartbeat<now()-interval '60 seconds'`,
      sql<Row[]>`WITH jobs AS(
      SELECT 'outbox' queue,organization_id,status,created_at FROM outbox_jobs
      UNION ALL SELECT 'media',organization_id,status,created_at FROM media_processing_jobs
      UNION ALL SELECT 'files',organization_id,status,created_at FROM file_processing_jobs
      UNION ALL SELECT 'crm',organization_id,status,created_at FROM crm_sync_jobs
      UNION ALL SELECT 'automation',organization_id,status,created_at FROM automation_events
      UNION ALL SELECT 'open_channels',organization_id,status,created_at FROM bitrix_open_channel_jobs
    ) SELECT queue,organization_id,
      count(*) FILTER(WHERE status IN('failed','dead_letter','blocked','manual_review'))::int failed,
      count(*) FILTER(WHERE status='retry')::int retries,
      min(created_at) FILTER(WHERE status IN('pending','queued','retry','processing')) oldest,
      min(created_at) FILTER(WHERE status='retry') oldest_retry
    FROM jobs GROUP BY queue,organization_id
    HAVING count(*) FILTER(WHERE status IN('failed','dead_letter','blocked','manual_review'))>0
      OR min(created_at) FILTER(WHERE status IN('pending','queued','retry','processing'))<now()-interval '15 minutes'
      OR count(*) FILTER(WHERE status='retry')>20
      OR min(created_at) FILTER(WHERE status='retry')<now()-interval '5 minutes'`,
      sql<
        Row[]
      >`SELECT organization_id,provider,status,last_error_code,updated_at FROM integration_connections WHERE status IN('error','degraded','disconnected','warning') AND updated_at<now()-interval '5 minutes'
      UNION ALL SELECT organization_id,provider,connection_status,health_code,updated_at FROM channels WHERE deleted_at IS NULL AND (connection_status IN('DISCONNECTED','ERROR') OR health_state IN('UNHEALTHY','CRITICAL')) AND updated_at<now()-interval '5 minutes'`,
      sql<
        Row[]
      >`SELECT organization_id,'webhook' kind,error_code code,created_at seen_at FROM billing_webhook_events WHERE status='failed' AND created_at>now()-interval '90 days'
      UNION ALL SELECT organization_id,'payment' kind,status code,updated_at seen_at FROM organization_subscriptions WHERE status IN('past_due','failed')`,
      sql<
        Row[]
      >`SELECT organization_id,trial_ends_at FROM organization_entitlements WHERE trial_status='active' AND trial_ends_at BETWEEN now() AND now()+interval '3 days'`,
      sql<
        Row[]
      >`SELECT id organization_id,activation_requested_at FROM organizations WHERE activation_status='pending' AND activation_requested_at<now()-interval '24 hours'`,
    ]);
  const result: AlertCandidate[] = [];
  for (const row of workers)
    result.push(
      candidate({
        key: String(row.instance_id),
        category: "worker",
        severity: "critical",
        organizationId: null,
        title: "Worker heartbeat gecikti",
        message: `${row.service} worker 60 saniyeden uzun süredir sinyal vermiyor.`,
        metadata: {
          service: row.service,
          instanceId: row.instance_id,
          lastHeartbeat: row.last_heartbeat,
        },
      }),
    );
  for (const row of queues) {
    const critical = Number(row.failed) > 0;
    result.push(
      candidate({
        key: String(row.queue),
        category: "queue",
        severity: critical ? "critical" : "warning",
        organizationId: String(row.organization_id),
        title: critical
          ? "Kuyrukta başarısız iş var"
          : "Kuyruk gecikmesi oluştu",
        message: `${row.queue} kuyruğu müdahale eşiğini aştı.`,
        metadata: {
          queue: row.queue,
          failed: Number(row.failed),
          retries: Number(row.retries),
          oldest: row.oldest,
          oldestRetry: row.oldest_retry,
        },
      }),
    );
  }
  for (const row of connections)
    result.push(
      candidate({
        key: `${row.provider}:${row.status}`,
        category: "integration",
        severity:
          String(row.status) === "error" || String(row.status) === "ERROR"
            ? "critical"
            : "warning",
        organizationId: String(row.organization_id),
        title: "Bağlantı sağlığı bozuldu",
        message: `${row.provider} bağlantısı beş dakikadan uzun süredir sağlıksız.`,
        metadata: {
          provider: row.provider,
          status: row.status,
          errorCode: row.last_error_code,
        },
      }),
    );
  for (const row of billing)
    result.push(
      candidate({
        key: `${row.kind}:${row.code}`,
        category: "billing",
        severity: "critical",
        organizationId: String(row.organization_id),
        title:
          row.kind === "webhook"
            ? "Billing webhook başarısız"
            : "Ödeme gecikmesi",
        message: "Abonelik operasyonu müdahale gerektiriyor.",
        metadata: { kind: row.kind, code: row.code, seenAt: row.seen_at },
      }),
    );
  for (const row of trials)
    result.push(
      candidate({
        key: "trial-ending",
        category: "trial",
        severity: "warning",
        organizationId: String(row.organization_id),
        title: "Deneme süresi yakında bitiyor",
        message: "Firma denemesi üç gün içinde sona erecek.",
        metadata: { trialEndsAt: row.trial_ends_at },
      }),
    );
  for (const row of approvals)
    result.push(
      candidate({
        key: "approval-overdue",
        category: "approval",
        severity: "warning",
        organizationId: String(row.organization_id),
        title: "Firma onayı gecikti",
        message: "Firma başvurusu 24 saatten uzun süredir bekliyor.",
        metadata: { requestedAt: row.activation_requested_at },
      }),
    );
  return result;
}

export async function persistPlatformAlerts(
  sql: Sql,
  candidates: AlertCandidate[],
) {
  return sql.begin(async (tx) => {
    const seen = candidates.map((item) => item.fingerprint);
    for (const item of candidates)
      await tx`INSERT INTO platform_alerts(fingerprint,category,severity,organization_id,status,title,message,safe_metadata)
      VALUES(${item.fingerprint},${item.category},${item.severity},${item.organizationId}::uuid,'open',${item.title},${item.message},${JSON.stringify(item.metadata)}::jsonb)
      ON CONFLICT(fingerprint) DO UPDATE SET severity=excluded.severity,title=excluded.title,message=excluded.message,safe_metadata=excluded.safe_metadata,last_seen_at=now(),status=CASE WHEN platform_alerts.status='resolved' THEN 'open' ELSE platform_alerts.status END,resolved_at=NULL,consecutive_healthy_scans=0,email_notified_at=CASE WHEN platform_alerts.severity<>excluded.severity THEN NULL ELSE platform_alerts.email_notified_at END,updated_at=now()`;
    await tx`UPDATE platform_alerts SET consecutive_healthy_scans=consecutive_healthy_scans+1,updated_at=now() WHERE status IN('open','acknowledged') AND NOT(fingerprint=ANY(${seen}::text[]))`;
    await tx`UPDATE platform_alerts SET status='resolved',resolved_at=now(),updated_at=now() WHERE status IN('open','acknowledged') AND consecutive_healthy_scans>=2`;
    await tx`DELETE FROM platform_alerts WHERE status='resolved' AND resolved_at<now()-interval '90 days'`;
  });
}

async function notifyCriticalAlerts(sql: Sql) {
  if (
    (process.env.EMAIL_PROVIDER ?? "disabled").toLowerCase() !== "smtp" ||
    !process.env.SMTP_HOST ||
    !process.env.EMAIL_FROM
  )
    return;
  const alerts = await sql<
    Row[]
  >`SELECT id,title,message FROM platform_alerts WHERE severity='critical' AND status='open' AND email_notified_at IS NULL ORDER BY first_seen_at LIMIT 20`;
  if (!alerts.length) return;
  const admins = await sql<
    Array<{ email: string }>
  >`SELECT email FROM users WHERE is_platform_admin=true AND is_active=true AND suspended_at IS NULL`;
  if (!admins.length) return;
  const port = Number(process.env.SMTP_PORT ?? 587);
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: process.env.SMTP_SECURE === "true" || port === 465,
    ...(process.env.SMTP_USERNAME && process.env.SMTP_PASSWORD
      ? {
          auth: {
            user: process.env.SMTP_USERNAME,
            pass: process.env.SMTP_PASSWORD,
          },
        }
      : {}),
  });
  for (const alert of alerts) {
    await transport.sendMail({
      from: process.env.EMAIL_FROM,
      to: admins.map((x) => x.email).join(","),
      subject: `[Brixchat24] ${alert.title}`,
      text: String(alert.message),
    });
    await sql`UPDATE platform_alerts SET email_notified_at=now(),updated_at=now() WHERE id=${String(alert.id)}::uuid AND email_notified_at IS NULL`;
  }
}

export async function scanPlatformAlerts(sql: Sql) {
  const candidates = await collectPlatformAlerts(sql);
  await persistPlatformAlerts(sql, candidates);
  await notifyCriticalAlerts(sql);
  return candidates.length;
}
