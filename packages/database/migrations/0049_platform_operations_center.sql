ALTER TABLE organizations
  ADD COLUMN activation_status text NOT NULL DEFAULT 'approved',
  ADD COLUMN status_reason text,
  ADD COLUMN activation_requested_at timestamptz,
  ADD COLUMN activated_at timestamptz,
  ADD COLUMN activated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN status_changed_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN status_changed_by uuid REFERENCES users(id) ON DELETE SET NULL;
--> statement-breakpoint
UPDATE organizations
SET activation_status='approved',
    activated_at=COALESCE(activated_at,onboarding_completed_at,created_at),
    status_changed_at=COALESCE(updated_at,created_at)
WHERE activation_status='approved';
--> statement-breakpoint
ALTER TABLE organizations
  DROP CONSTRAINT IF EXISTS organizations_operational_status_check;
ALTER TABLE organizations
  ADD CONSTRAINT organizations_operational_status_check
    CHECK (operational_status IN ('pending_review','active','disabled','rejected')),
  ADD CONSTRAINT organizations_activation_status_check
    CHECK (activation_status IN ('pending','approved','rejected'));
CREATE INDEX organizations_status_created_idx
  ON organizations(operational_status,created_at DESC);
CREATE INDEX organizations_activation_requested_idx
  ON organizations(activation_status,activation_requested_at)
  WHERE activation_status='pending';
CREATE INDEX organization_entitlements_trial_idx
  ON organization_entitlements(trial_status,trial_ends_at);
CREATE INDEX worker_instances_last_heartbeat_idx
  ON worker_instances(last_heartbeat DESC);
--> statement-breakpoint
ALTER TABLE tenant_provisioning_audit
  ADD COLUMN actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN target_type text,
  ADD COLUMN target_id uuid,
  ADD COLUMN request_id text,
  ADD COLUMN ip_address inet,
  ADD COLUMN user_agent text,
  ADD COLUMN reason text,
  ADD COLUMN before_state jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN after_state jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN severity text NOT NULL DEFAULT 'info';
CREATE INDEX tenant_provisioning_audit_org_time_idx
  ON tenant_provisioning_audit(organization_id,created_at DESC);
CREATE INDEX tenant_provisioning_audit_actor_time_idx
  ON tenant_provisioning_audit(actor_user_id,created_at DESC);
CREATE INDEX tenant_provisioning_audit_action_time_idx
  ON tenant_provisioning_audit(action,created_at DESC);
--> statement-breakpoint
CREATE TABLE platform_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fingerprint text NOT NULL UNIQUE,
  category text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('info','warning','critical')),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','acknowledged','resolved')),
  title text NOT NULL,
  message text NOT NULL,
  safe_metadata jsonb NOT NULL DEFAULT '{}',
  consecutive_healthy_scans integer NOT NULL DEFAULT 0,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  acknowledged_by uuid REFERENCES users(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  email_notified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX platform_alerts_status_severity_idx
  ON platform_alerts(status,severity,last_seen_at DESC);
CREATE INDEX platform_alerts_org_status_idx
  ON platform_alerts(organization_id,status,last_seen_at DESC);
CREATE INDEX platform_alerts_retention_idx
  ON platform_alerts(resolved_at)
  WHERE status='resolved';
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='brixchat_live_api') THEN
    GRANT SELECT,INSERT,UPDATE,DELETE ON platform_alerts TO brixchat_live_api;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='brixchat_live_worker') THEN
    GRANT SELECT,INSERT,UPDATE,DELETE ON platform_alerts TO brixchat_live_worker;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='brixchat_app_scoped') THEN
    REVOKE ALL ON platform_alerts FROM brixchat_app_scoped;
  END IF;
END $$;
