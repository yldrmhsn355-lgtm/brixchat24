import postgres from "postgres";

type ReviewCase = {
  connection_id: string;
  conversation_id: string;
  contact_name: string | null;
  normalized_phone: string;
  channel_name: string;
  head_status: string;
  last_error: string | null;
  job_count: number;
  oldest_job_at: string;
  newest_job_at: string;
};

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const cases = await sql<ReviewCase[]>`
      SELECT
        job.integration_connection_id::text AS connection_id,
        job.conversation_id::text AS conversation_id,
        contact.display_name AS contact_name,
        contact.normalized_phone,
        channel.name AS channel_name,
        (array_agg(job.status ORDER BY job.updated_at DESC))[1] AS head_status,
        (array_agg(job.last_error ORDER BY job.updated_at DESC))[1] AS last_error,
        count(*)::int AS job_count,
        min(job.created_at)::text AS oldest_job_at,
        max(job.updated_at)::text AS newest_job_at
      FROM bitrix_open_channel_jobs job
      JOIN conversations conversation
        ON conversation.id=job.conversation_id
       AND conversation.organization_id=job.organization_id
      JOIN contacts contact
        ON contact.id=conversation.contact_id
       AND contact.organization_id=conversation.organization_id
      JOIN channels channel
        ON channel.id=conversation.channel_id
       AND channel.organization_id=conversation.organization_id
      WHERE job.job_type='open_channels.crm'
        AND job.status IN('manual_review','dead_letter','blocked')
      GROUP BY job.integration_connection_id,job.conversation_id,
        contact.display_name,contact.normalized_phone,channel.name
      ORDER BY job_count DESC,contact.display_name NULLS LAST`;
    console.log(
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          totalCases: cases.length,
          totalJobs: cases.reduce((total, item) => total + item.job_count, 0),
          cases,
        },
        null,
        2,
      ),
    );
  } finally {
    await sql.end();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
