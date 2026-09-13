-- Line-based commercial activation. Plan channel allowances remain the base
-- capacity; approved/purchased channel items add capacity only to their own
-- messaging family (WhatsApp or Telegram).

CREATE TABLE IF NOT EXISTS billing_sales_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES billing_products(id),
  quantity integer NOT NULL CHECK(quantity BETWEEN 1 AND 500),
  status text NOT NULL DEFAULT 'pending'
    CHECK(status IN('pending','approved','rejected','canceled')),
  customer_note text,
  review_note text,
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS billing_sales_requests_org_status_idx
  ON billing_sales_requests(organization_id,status,created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS billing_sales_requests_pending_product_uq
  ON billing_sales_requests(organization_id,product_id) WHERE status='pending';

UPDATE billing_products SET features='{"channel":"whatsapp"}'::jsonb,
  updated_at=now() WHERE code='whatsapp_line';
UPDATE billing_products SET features='{"channel":"telegram"}'::jsonb,
  updated_at=now() WHERE code='telegram_line';

ALTER TABLE billing_sales_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_sales_requests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS billing_sales_requests_tenant_scope ON billing_sales_requests;
CREATE POLICY billing_sales_requests_tenant_scope ON billing_sales_requests
  USING (organization_id = nullif(current_setting('app.organization_id',true),'')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id',true),'')::uuid);

GRANT SELECT,INSERT,UPDATE,DELETE ON billing_sales_requests TO brixchat_app_scoped;
