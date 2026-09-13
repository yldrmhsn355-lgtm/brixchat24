ALTER TABLE crm_user_mappings
  ADD COLUMN IF NOT EXISTS crm_policy jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE crm_user_mappings
  DROP CONSTRAINT IF EXISTS crm_user_mappings_crm_policy_check;

ALTER TABLE crm_user_mappings
  ADD CONSTRAINT crm_user_mappings_crm_policy_check CHECK (
    COALESCE(crm_policy->>'mode', 'inherit') IN (
      'inherit', 'disabled', 'lead', 'contact_and_deal'
    )
    AND (
      NOT (crm_policy ? 'sourceId')
      OR jsonb_typeof(crm_policy->'sourceId') = 'string'
    )
  );
