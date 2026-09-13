CREATE TABLE IF NOT EXISTS crm_contact_exclusions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  normalized_phone text NOT NULL,
  display_name text,
  reason text NOT NULL DEFAULT 'internal_contact',
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crm_contact_exclusions_phone_format_chk
    CHECK (normalized_phone ~ '^\+[1-9][0-9]{7,14}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS crm_contact_exclusions_active_phone_uq
  ON crm_contact_exclusions(organization_id,normalized_phone)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS crm_contact_exclusions_org_active_idx
  ON crm_contact_exclusions(organization_id,archived_at,created_at DESC);

ALTER TABLE crm_contact_exclusions ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE crm_contact_exclusions FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    EXECUTE 'REVOKE ALL ON TABLE crm_contact_exclusions FROM authenticated';
  END IF;
END $$;

-- Preserve every per-message job, but expose only one actionable review head
-- per conversation. Blocked siblings are released in order after the head is
-- resolved, retried, or completed.
WITH ranked AS (
  SELECT id,
    row_number() OVER (
      PARTITION BY organization_id,integration_connection_id,conversation_id
      ORDER BY
        CASE status
          WHEN 'manual_review' THEN 0
          WHEN 'dead_letter' THEN 1
          WHEN 'processing' THEN 2
          WHEN 'retry' THEN 3
          ELSE 4
        END,
        created_at,
        id
    ) AS position
  FROM bitrix_open_channel_jobs
  WHERE job_type='open_channels.crm'
    AND status IN ('pending','retry','processing','manual_review','dead_letter')
)
UPDATE bitrix_open_channel_jobs job
SET status='blocked',
  last_error='CRM_REVIEW_PENDING',
  locked_at=NULL,
  locked_by=NULL,
  updated_at=now()
FROM ranked
WHERE ranked.id=job.id AND ranked.position>1;

CREATE UNIQUE INDEX IF NOT EXISTS bitrix_open_channel_jobs_crm_review_head_uq
  ON bitrix_open_channel_jobs(
    organization_id,integration_connection_id,conversation_id
  )
  WHERE job_type='open_channels.crm'
    AND status IN ('pending','retry','processing','manual_review','dead_letter');

