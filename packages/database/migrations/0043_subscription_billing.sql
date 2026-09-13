-- Subscription billing: provider-neutral commercial core with a Paddle-first
-- adapter. Additive and forward-only; existing tenants keep their current
-- entitlement and are never charged or disabled by this migration.

CREATE TABLE IF NOT EXISTS billing_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  product_type text NOT NULL CHECK(product_type IN('plan','channel','seat','credit')),
  plan_code text REFERENCES plans(code),
  features jsonb NOT NULL DEFAULT '{}',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS billing_prices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES billing_products(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'manual',
  provider_price_ref text,
  currency text NOT NULL DEFAULT 'USD' CHECK(currency ~ '^[A-Z]{3}$'),
  interval text NOT NULL CHECK(interval IN('month','year','one_time')),
  unit_amount_minor bigint NOT NULL CHECK(unit_amount_minor >= 0),
  credits_per_unit bigint CHECK(credits_per_unit IS NULL OR credits_per_unit > 0),
  tax_mode text NOT NULL DEFAULT 'provider' CHECK(tax_mode IN('provider','inclusive','exclusive')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(product_id,provider,currency,interval)
);
CREATE UNIQUE INDEX IF NOT EXISTS billing_prices_provider_ref_uq
  ON billing_prices(provider,provider_price_ref) WHERE provider_price_ref IS NOT NULL;

CREATE TABLE IF NOT EXISTS organization_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'manual',
  provider_customer_ref text,
  provider_subscription_ref text,
  plan_code text REFERENCES plans(code),
  status text NOT NULL CHECK(status IN('trialing','active','past_due','paused','canceled','incomplete','legacy_free','manual')),
  current_period_start timestamptz,
  current_period_end timestamptz,
  grace_ends_at timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  last_provider_occurred_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id,provider)
);
CREATE UNIQUE INDEX IF NOT EXISTS organization_subscriptions_provider_ref_uq
  ON organization_subscriptions(provider,provider_subscription_ref)
  WHERE provider_subscription_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS organization_subscriptions_status_idx
  ON organization_subscriptions(status,current_period_end);

CREATE TABLE IF NOT EXISTS subscription_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  subscription_id uuid NOT NULL REFERENCES organization_subscriptions(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES billing_products(id),
  price_id uuid REFERENCES billing_prices(id),
  provider_item_ref text,
  quantity integer NOT NULL DEFAULT 1 CHECK(quantity > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(subscription_id,product_id)
);

CREATE TABLE IF NOT EXISTS billing_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  subscription_id uuid REFERENCES organization_subscriptions(id) ON DELETE SET NULL,
  provider text NOT NULL,
  provider_transaction_ref text NOT NULL,
  status text NOT NULL CHECK(status IN('draft','ready','billed','paid','past_due','canceled','failed')),
  currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
  subtotal_minor bigint NOT NULL DEFAULT 0,
  tax_minor bigint NOT NULL DEFAULT 0,
  total_minor bigint NOT NULL DEFAULT 0,
  invoice_number text,
  billed_at timestamptz,
  provider_occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(provider,provider_transaction_ref)
);
ALTER TABLE billing_transactions
  ADD COLUMN IF NOT EXISTS provider_occurred_at timestamptz;
UPDATE billing_transactions SET provider_occurred_at=COALESCE(provider_occurred_at,created_at)
  WHERE provider_occurred_at IS NULL;
ALTER TABLE billing_transactions ALTER COLUMN provider_occurred_at SET NOT NULL;

CREATE TABLE IF NOT EXISTS billing_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider text NOT NULL,
  provider_event_id text NOT NULL,
  event_type text NOT NULL,
  payload_hash text NOT NULL,
  occurred_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'processing' CHECK(status IN('processing','processed','ignored','failed')),
  error_code text,
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(provider,provider_event_id)
);
CREATE INDEX IF NOT EXISTS billing_webhook_events_org_time_idx
  ON billing_webhook_events(organization_id,occurred_at DESC);

CREATE TABLE IF NOT EXISTS usage_period_counters (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  metric text NOT NULL,
  period_start date NOT NULL,
  quantity bigint NOT NULL DEFAULT 0 CHECK(quantity >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(organization_id,metric,period_start)
);

CREATE TABLE IF NOT EXISTS credit_accounts (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  balance bigint NOT NULL DEFAULT 0 CHECK(balance >= 0),
  total_purchased bigint NOT NULL DEFAULT 0 CHECK(total_purchased >= 0),
  total_used bigint NOT NULL DEFAULT 0 CHECK(total_used >= 0),
  auto_recharge_enabled boolean NOT NULL DEFAULT false,
  auto_recharge_threshold bigint NOT NULL DEFAULT 100 CHECK(auto_recharge_threshold >= 0),
  auto_recharge_amount bigint NOT NULL DEFAULT 1000 CHECK(auto_recharge_amount > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS credit_ledger_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  entry_key text NOT NULL,
  entry_type text NOT NULL CHECK(entry_type IN('purchase','usage','refund','adjustment')),
  amount bigint NOT NULL CHECK(amount <> 0),
  balance_after bigint NOT NULL CHECK(balance_after >= 0),
  reference_type text,
  reference_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id,entry_key)
);
CREATE INDEX IF NOT EXISTS credit_ledger_entries_org_time_idx
  ON credit_ledger_entries(organization_id,created_at DESC);

INSERT INTO billing_products(code,name,product_type,plan_code,features) VALUES
  ('starter','Starter','plan','starter','{}'),
  ('professional','Professional','plan','professional','{}'),
  ('enterprise','Enterprise','plan','enterprise','{}'),
  ('whatsapp_line','WhatsApp Hattı','channel',NULL,'{"channel":"whatsapp"}'),
  ('telegram_line','Telegram Hattı','channel',NULL,'{"channel":"telegram"}'),
  ('ai_credits','AI Kredisi','credit',NULL,'{}')
ON CONFLICT(code) DO UPDATE SET name=excluded.name,product_type=excluded.product_type,
  plan_code=excluded.plan_code,features=excluded.features,updated_at=now();

UPDATE plans SET limits=limits || CASE code
  WHEN 'development' THEN '{"monthly_ai_runs":100000}'::jsonb
  WHEN 'trial' THEN '{"monthly_ai_runs":50}'::jsonb
  WHEN 'starter' THEN '{"monthly_ai_runs":500}'::jsonb
  WHEN 'professional' THEN '{"monthly_ai_runs":5000}'::jsonb
  WHEN 'enterprise' THEN '{"monthly_ai_runs":null}'::jsonb
  ELSE '{}'::jsonb
END
WHERE code IN('development','trial','starter','professional','enterprise');

-- Preserve every existing customer as explicitly non-billable until an owner
-- completes checkout or a platform admin opts the tenant into paid billing.
INSERT INTO organization_subscriptions(organization_id,provider,plan_code,status)
SELECT o.id,'manual',p.code,'legacy_free'
FROM organizations o
LEFT JOIN organization_entitlements e ON e.organization_id=o.id
LEFT JOIN plans p ON p.id=e.plan_id
ON CONFLICT(organization_id,provider) DO NOTHING;

INSERT INTO credit_accounts(organization_id)
SELECT id FROM organizations ON CONFLICT(organization_id) DO NOTHING;

-- Tenant-scoped commercial data uses the same session context as the rest of
-- the scoped API. Global catalog tables intentionally remain readable.
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'organization_subscriptions','subscription_items','billing_transactions',
    'billing_webhook_events','usage_period_counters','credit_accounts',
    'credit_ledger_entries'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I',table_name||'_tenant_scope',table_name);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (organization_id = nullif(current_setting(''app.organization_id'',true),'''')::uuid) WITH CHECK (organization_id = nullif(current_setting(''app.organization_id'',true),'''')::uuid)',
      table_name||'_tenant_scope',table_name
    );
  END LOOP;
END $$;

GRANT SELECT ON billing_products,billing_prices TO brixchat_app_scoped;
GRANT SELECT,INSERT,UPDATE,DELETE ON organization_subscriptions,subscription_items,
  billing_transactions,billing_webhook_events,usage_period_counters,credit_accounts,
  credit_ledger_entries TO brixchat_app_scoped;
