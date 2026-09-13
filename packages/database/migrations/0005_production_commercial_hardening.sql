-- Milestone 6: additive, forward-only commercial and operational controls.
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS operational_status text NOT NULL DEFAULT 'active' CHECK(operational_status IN('active','disabled')),
  ADD COLUMN IF NOT EXISTS disabled_at timestamptz;

CREATE TABLE IF NOT EXISTS plans (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),code text NOT NULL UNIQUE,display_name text NOT NULL,
 limits jsonb NOT NULL DEFAULT '{}',active boolean NOT NULL DEFAULT true,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS organization_entitlements (
 organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,plan_id uuid NOT NULL REFERENCES plans(id),
 trial_started_at timestamptz,trial_ends_at timestamptz,trial_status text NOT NULL DEFAULT 'inactive' CHECK(trial_status IN('inactive','active','grace','expired')),
 grace_ends_at timestamptz,overrides jsonb NOT NULL DEFAULT '{}',updated_by uuid REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS organization_usage_limits (
 organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,metric text NOT NULL,hard_limit bigint,warning_limit bigint,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(organization_id,metric)
);
CREATE TABLE IF NOT EXISTS usage_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,event_key text NOT NULL,
 metric text NOT NULL,quantity bigint NOT NULL DEFAULT 1 CHECK(quantity>=0),occurred_at timestamptz NOT NULL DEFAULT now(),metadata jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(organization_id,event_key)
);
CREATE INDEX IF NOT EXISTS usage_events_rollup_idx ON usage_events(organization_id,occurred_at,metric);
CREATE TABLE IF NOT EXISTS usage_daily_rollups (
 organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,usage_date date NOT NULL,metric text NOT NULL,quantity bigint NOT NULL DEFAULT 0,
 updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(organization_id,usage_date,metric)
);

CREATE TABLE IF NOT EXISTS privacy_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 request_type text NOT NULL CHECK(request_type IN('export','delete','restrict')),subject_reference_hash text NOT NULL,reason text,
 status text NOT NULL DEFAULT 'requested' CHECK(status IN('requested','approved','processing','completed','rejected','blocked')),
 requested_by uuid NOT NULL REFERENCES users(id),approved_by uuid REFERENCES users(id),legal_hold_conflict boolean NOT NULL DEFAULT false,
 requested_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz,updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS privacy_requests_org_status_idx ON privacy_requests(organization_id,status,requested_at DESC);
CREATE TABLE IF NOT EXISTS privacy_request_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 request_id uuid NOT NULL REFERENCES privacy_requests(id) ON DELETE CASCADE,event_type text NOT NULL,actor_id uuid REFERENCES users(id),metadata jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS consent_records (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 subject_reference_hash text NOT NULL,purpose text NOT NULL,status text NOT NULL CHECK(status IN('granted','withdrawn','unknown')),source text NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT now(),withdrawn_at timestamptz,UNIQUE(organization_id,subject_reference_hash,purpose)
);
CREATE TABLE IF NOT EXISTS processing_activity_logs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 activity_type text NOT NULL,legal_basis text NOT NULL,metadata jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS worker_instances (
 instance_id text PRIMARY KEY,service text NOT NULL,version text NOT NULL,started_at timestamptz NOT NULL DEFAULT now(),last_heartbeat timestamptz NOT NULL DEFAULT now(),
 current_jobs integer NOT NULL DEFAULT 0,processed_count bigint NOT NULL DEFAULT 0,failed_count bigint NOT NULL DEFAULT 0,status text NOT NULL DEFAULT 'healthy',safe_metadata jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS worker_instances_health_idx ON worker_instances(service,last_heartbeat DESC);
CREATE TABLE IF NOT EXISTS worker_heartbeats (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,instance_id text NOT NULL REFERENCES worker_instances(instance_id) ON DELETE CASCADE,
 current_jobs integer NOT NULL DEFAULT 0,status text NOT NULL,recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS worker_heartbeats_recent_idx ON worker_heartbeats(instance_id,recorded_at DESC);
CREATE TABLE IF NOT EXISTS tenant_provisioning_audit (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid REFERENCES organizations(id) ON DELETE SET NULL,action text NOT NULL,actor text NOT NULL,
 details jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO plans(code,display_name,limits) VALUES
 ('development','Development','{"users":100,"channels":100,"monthly_outgoing_messages":100000,"storage_bytes":107374182400,"automations":100,"open_channels":true}'),
 ('trial','Trial','{"users":5,"channels":2,"monthly_outgoing_messages":1000,"storage_bytes":1073741824,"automations":3,"open_channels":false}'),
 ('starter','Starter','{"users":10,"channels":3,"monthly_outgoing_messages":5000,"storage_bytes":5368709120,"automations":10,"open_channels":false}'),
 ('professional','Professional','{"users":50,"channels":10,"monthly_outgoing_messages":50000,"storage_bytes":53687091200,"automations":100,"open_channels":true}'),
 ('enterprise','Enterprise','{"users":null,"channels":null,"monthly_outgoing_messages":null,"storage_bytes":null,"automations":null,"open_channels":true}')
ON CONFLICT(code) DO UPDATE SET display_name=excluded.display_name,limits=excluded.limits,updated_at=now();
INSERT INTO organization_entitlements(organization_id,plan_id,trial_status)
SELECT o.id,p.id,'inactive' FROM organizations o CROSS JOIN plans p WHERE p.code='development'
ON CONFLICT(organization_id) DO NOTHING;
