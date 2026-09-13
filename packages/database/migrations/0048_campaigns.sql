CREATE TABLE campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  channel_id uuid NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  content jsonb NOT NULL,
  request_key uuid NOT NULL,
  content_hash text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','queued','processing','completed','canceled')),
  dry_run_token uuid,
  dry_run_at timestamptz,
  dry_run_result jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id,id),
  UNIQUE (organization_id,request_key),
  FOREIGN KEY (organization_id,channel_id) REFERENCES channels(organization_id,id)
);
--> statement-breakpoint
CREATE TABLE campaign_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  campaign_id uuid NOT NULL,
  phone text NOT NULL CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
  name text NOT NULL DEFAULT '' CHECK (length(name)<=120),
  client_message_id uuid NOT NULL DEFAULT gen_random_uuid(),
  message_id uuid,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','queued','sent','failed','canceled')),
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id,id),
  UNIQUE (organization_id,campaign_id,phone),
  UNIQUE (organization_id,client_message_id),
  FOREIGN KEY (organization_id,campaign_id) REFERENCES campaigns(organization_id,id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id,message_id) REFERENCES messages(organization_id,id)
);
--> statement-breakpoint
CREATE INDEX campaigns_pending_idx ON campaigns(status,created_at) WHERE status IN ('queued','processing');
CREATE INDEX campaign_recipients_pending_idx ON campaign_recipients(campaign_id,status,created_at);
--> statement-breakpoint
ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_recipients ENABLE ROW LEVEL SECURITY;
CREATE POLICY api_tenant_access ON campaigns FOR ALL TO brixchat_app_scoped
  USING (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid)
  WITH CHECK (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid);
CREATE POLICY api_tenant_boundary ON campaigns AS RESTRICTIVE FOR ALL TO brixchat_app_scoped
  USING (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid)
  WITH CHECK (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid);
CREATE POLICY api_tenant_access ON campaign_recipients FOR ALL TO brixchat_app_scoped
  USING (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid)
  WITH CHECK (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid);
CREATE POLICY api_tenant_boundary ON campaign_recipients AS RESTRICTIVE FOR ALL TO brixchat_app_scoped
  USING (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid)
  WITH CHECK (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE,DELETE ON campaigns,campaign_recipients TO brixchat_app_scoped;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='brixchat_live_worker') THEN
    GRANT SELECT,INSERT,UPDATE,DELETE ON campaigns,campaign_recipients TO brixchat_live_worker;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='brixchat_live_api') THEN
    GRANT SELECT,INSERT,UPDATE,DELETE ON campaigns,campaign_recipients TO brixchat_live_api;
  END IF;
END $$;
