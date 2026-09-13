-- AI Agent Platform foundation.
-- Adds org-scoped AI agents with immutable versions (mirroring the
-- automation_rules / automation_rule_versions split), channel assignments,
-- knowledge bases with chunked documents for retrieval, per-conversation AI
-- state (pause / takeover / override), durable run requests (debounced,
-- per-conversation serialized queue like automation_events), auditable runs,
-- feedback + training examples, evaluation datasets, and daily usage rollups.
-- Embeddings are stored as jsonb float arrays: the local/production image is
-- stock postgres:17-alpine without pgvector, so retrieval is hybrid
-- (FTS candidate generation + in-process cosine ranking). A later migration
-- can add a vector column when the pgvector extension becomes available.

CREATE TABLE IF NOT EXISTS ai_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL
    REFERENCES organizations(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  api_key_encrypted text,
  default_model text,
  fallback_model text,
  daily_budget_usd numeric(12,4),
  debounce_ms integer NOT NULL DEFAULT 3000,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ai_settings_org_uq
  ON ai_settings(organization_id);

ALTER TABLE ai_settings
  DROP CONSTRAINT IF EXISTS ai_settings_debounce_ms_check;
ALTER TABLE ai_settings
  ADD CONSTRAINT ai_settings_debounce_ms_check
  CHECK (debounce_ms BETWEEN 0 AND 120000);

CREATE TABLE IF NOT EXISTS ai_agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL
    REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'draft',
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  archived_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ai_agents_org_name_uq
  ON ai_agents(organization_id,name);
CREATE INDEX IF NOT EXISTS ai_agents_org_status_idx
  ON ai_agents(organization_id,status);

ALTER TABLE ai_agents
  DROP CONSTRAINT IF EXISTS ai_agents_status_check;
ALTER TABLE ai_agents
  ADD CONSTRAINT ai_agents_status_check
  CHECK (status IN ('draft','active','paused','archived'));

CREATE TABLE IF NOT EXISTS ai_agent_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL
    REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL
    REFERENCES ai_agents(id) ON DELETE CASCADE,
  version integer NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  mode text NOT NULL DEFAULT 'copilot',
  model text NOT NULL DEFAULT '',
  fallback_model text,
  temperature numeric(3,2) NOT NULL DEFAULT 0.30,
  max_steps integer NOT NULL DEFAULT 6,
  max_cost_per_run_usd numeric(10,4) NOT NULL DEFAULT 0.25,
  default_language text NOT NULL DEFAULT 'tr',
  allowed_languages jsonb NOT NULL DEFAULT '[]'::jsonb,
  system_instruction text NOT NULL DEFAULT '',
  business_objective text NOT NULL DEFAULT '',
  persona jsonb NOT NULL DEFAULT '{}'::jsonb,
  behavior_rules jsonb NOT NULL DEFAULT '[]'::jsonb,
  forbidden_topics jsonb NOT NULL DEFAULT '[]'::jsonb,
  example_responses jsonb NOT NULL DEFAULT '[]'::jsonb,
  handoff_rules jsonb NOT NULL DEFAULT '{}'::jsonb,
  confidence_threshold numeric(3,2) NOT NULL DEFAULT 0.60,
  working_hours jsonb NOT NULL DEFAULT '{}'::jsonb,
  response_delay_min_ms integer NOT NULL DEFAULT 0,
  response_delay_max_ms integer NOT NULL DEFAULT 0,
  tool_permissions jsonb NOT NULL DEFAULT '{}'::jsonb,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  published_at timestamptz,
  retired_at timestamptz,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ai_agent_versions_agent_version_uq
  ON ai_agent_versions(agent_id,version);
CREATE INDEX IF NOT EXISTS ai_agent_versions_org_agent_idx
  ON ai_agent_versions(organization_id,agent_id,version DESC);

ALTER TABLE ai_agent_versions
  DROP CONSTRAINT IF EXISTS ai_agent_versions_status_check;
ALTER TABLE ai_agent_versions
  ADD CONSTRAINT ai_agent_versions_status_check
  CHECK (status IN ('draft','published','retired'));
ALTER TABLE ai_agent_versions
  DROP CONSTRAINT IF EXISTS ai_agent_versions_mode_check;
ALTER TABLE ai_agent_versions
  ADD CONSTRAINT ai_agent_versions_mode_check
  CHECK (mode IN ('observe','copilot','approval','autopilot'));
ALTER TABLE ai_agent_versions
  DROP CONSTRAINT IF EXISTS ai_agent_versions_max_steps_check;
ALTER TABLE ai_agent_versions
  ADD CONSTRAINT ai_agent_versions_max_steps_check
  CHECK (max_steps BETWEEN 1 AND 32);
ALTER TABLE ai_agent_versions
  DROP CONSTRAINT IF EXISTS ai_agent_versions_confidence_check;
ALTER TABLE ai_agent_versions
  ADD CONSTRAINT ai_agent_versions_confidence_check
  CHECK (confidence_threshold BETWEEN 0 AND 1);

-- Version pointers are added after both tables exist (mutual reference).
ALTER TABLE ai_agents
  ADD COLUMN IF NOT EXISTS draft_version_id uuid
    REFERENCES ai_agent_versions(id) ON DELETE SET NULL;
ALTER TABLE ai_agents
  ADD COLUMN IF NOT EXISTS published_version_id uuid
    REFERENCES ai_agent_versions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS ai_agents_draft_version_idx
  ON ai_agents(draft_version_id);
CREATE INDEX IF NOT EXISTS ai_agents_published_version_idx
  ON ai_agents(published_version_id);

CREATE TABLE IF NOT EXISTS ai_agent_channel_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL
    REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL
    REFERENCES ai_agents(id) ON DELETE CASCADE,
  channel_id uuid NOT NULL
    REFERENCES channels(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  mode_override text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ai_agent_channel_assignments_org_channel_uq
  ON ai_agent_channel_assignments(organization_id,channel_id);
CREATE INDEX IF NOT EXISTS ai_agent_channel_assignments_agent_idx
  ON ai_agent_channel_assignments(agent_id);

ALTER TABLE ai_agent_channel_assignments
  DROP CONSTRAINT IF EXISTS ai_agent_channel_assignments_mode_check;
ALTER TABLE ai_agent_channel_assignments
  ADD CONSTRAINT ai_agent_channel_assignments_mode_check
  CHECK (mode_override IS NULL
    OR mode_override IN ('observe','copilot','approval','autopilot'));

CREATE TABLE IF NOT EXISTS ai_knowledge_bases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL
    REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  scope text NOT NULL DEFAULT 'workspace',
  channel_id uuid REFERENCES channels(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'active',
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ai_knowledge_bases_org_name_uq
  ON ai_knowledge_bases(organization_id,name);
CREATE INDEX IF NOT EXISTS ai_knowledge_bases_channel_idx
  ON ai_knowledge_bases(channel_id);

ALTER TABLE ai_knowledge_bases
  DROP CONSTRAINT IF EXISTS ai_knowledge_bases_scope_check;
ALTER TABLE ai_knowledge_bases
  ADD CONSTRAINT ai_knowledge_bases_scope_check
  CHECK (scope IN ('workspace','agent','channel'));
ALTER TABLE ai_knowledge_bases
  DROP CONSTRAINT IF EXISTS ai_knowledge_bases_status_check;
ALTER TABLE ai_knowledge_bases
  ADD CONSTRAINT ai_knowledge_bases_status_check
  CHECK (status IN ('active','archived'));

CREATE TABLE IF NOT EXISTS ai_knowledge_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL
    REFERENCES organizations(id) ON DELETE CASCADE,
  knowledge_base_id uuid NOT NULL
    REFERENCES ai_knowledge_bases(id) ON DELETE CASCADE,
  title text NOT NULL,
  source_type text NOT NULL DEFAULT 'text',
  source_ref text,
  content text NOT NULL DEFAULT '',
  language text,
  status text NOT NULL DEFAULT 'pending',
  error_message text,
  chunk_count integer NOT NULL DEFAULT 0,
  version integer NOT NULL DEFAULT 1,
  indexed_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_knowledge_documents_org_kb_idx
  ON ai_knowledge_documents(organization_id,knowledge_base_id);
CREATE INDEX IF NOT EXISTS ai_knowledge_documents_status_idx
  ON ai_knowledge_documents(organization_id,status);

ALTER TABLE ai_knowledge_documents
  DROP CONSTRAINT IF EXISTS ai_knowledge_documents_source_type_check;
ALTER TABLE ai_knowledge_documents
  ADD CONSTRAINT ai_knowledge_documents_source_type_check
  CHECK (source_type IN ('text','faq','snippet','file','url','conversation'));
ALTER TABLE ai_knowledge_documents
  DROP CONSTRAINT IF EXISTS ai_knowledge_documents_status_check;
ALTER TABLE ai_knowledge_documents
  ADD CONSTRAINT ai_knowledge_documents_status_check
  CHECK (status IN ('pending','indexing','ready','failed'));

CREATE TABLE IF NOT EXISTS ai_knowledge_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL
    REFERENCES organizations(id) ON DELETE CASCADE,
  document_id uuid NOT NULL
    REFERENCES ai_knowledge_documents(id) ON DELETE CASCADE,
  knowledge_base_id uuid NOT NULL
    REFERENCES ai_knowledge_bases(id) ON DELETE CASCADE,
  chunk_index integer NOT NULL,
  document_version integer NOT NULL DEFAULT 1,
  content text NOT NULL,
  token_count integer NOT NULL DEFAULT 0,
  embedding jsonb,
  embedding_model text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ai_knowledge_chunks_doc_version_index_uq
  ON ai_knowledge_chunks(document_id,document_version,chunk_index);
CREATE INDEX IF NOT EXISTS ai_knowledge_chunks_org_kb_idx
  ON ai_knowledge_chunks(organization_id,knowledge_base_id);
CREATE INDEX IF NOT EXISTS ai_knowledge_chunks_content_search_idx
  ON ai_knowledge_chunks USING gin(to_tsvector('simple',coalesce(content,'')));

CREATE TABLE IF NOT EXISTS ai_agent_knowledge (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL
    REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL
    REFERENCES ai_agents(id) ON DELETE CASCADE,
  knowledge_base_id uuid NOT NULL
    REFERENCES ai_knowledge_bases(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ai_agent_knowledge_agent_kb_uq
  ON ai_agent_knowledge(agent_id,knowledge_base_id);
CREATE INDEX IF NOT EXISTS ai_agent_knowledge_org_kb_idx
  ON ai_agent_knowledge(organization_id,knowledge_base_id);

CREATE TABLE IF NOT EXISTS ai_conversation_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL
    REFERENCES organizations(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL
    REFERENCES conversations(id) ON DELETE CASCADE,
  agent_id uuid REFERENCES ai_agents(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'active',
  mode_override text,
  paused_until timestamptz,
  paused_reason text,
  paused_by uuid REFERENCES users(id) ON DELETE SET NULL,
  human_takeover_at timestamptz,
  last_ai_message_at timestamptz,
  consecutive_ai_messages integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ai_conversation_settings_conversation_uq
  ON ai_conversation_settings(conversation_id);
CREATE INDEX IF NOT EXISTS ai_conversation_settings_org_status_idx
  ON ai_conversation_settings(organization_id,status);
CREATE INDEX IF NOT EXISTS ai_conversation_settings_agent_idx
  ON ai_conversation_settings(agent_id);

ALTER TABLE ai_conversation_settings
  DROP CONSTRAINT IF EXISTS ai_conversation_settings_status_check;
ALTER TABLE ai_conversation_settings
  ADD CONSTRAINT ai_conversation_settings_status_check
  CHECK (status IN ('active','paused','disabled'));
ALTER TABLE ai_conversation_settings
  DROP CONSTRAINT IF EXISTS ai_conversation_settings_mode_check;
ALTER TABLE ai_conversation_settings
  ADD CONSTRAINT ai_conversation_settings_mode_check
  CHECK (mode_override IS NULL
    OR mode_override IN ('observe','copilot','approval','autopilot'));

CREATE TABLE IF NOT EXISTS ai_conversation_summaries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL
    REFERENCES organizations(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL
    REFERENCES conversations(id) ON DELETE CASCADE,
  summary text NOT NULL,
  facts jsonb NOT NULL DEFAULT '{}'::jsonb,
  covered_message_count integer NOT NULL DEFAULT 0,
  last_message_id uuid,
  last_message_at timestamptz,
  model text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_conversation_summaries_conversation_idx
  ON ai_conversation_summaries(conversation_id,created_at DESC);
CREATE INDEX IF NOT EXISTS ai_conversation_summaries_org_idx
  ON ai_conversation_summaries(organization_id,created_at DESC);

CREATE TABLE IF NOT EXISTS ai_customer_memory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL
    REFERENCES organizations(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL
    REFERENCES contacts(id) ON DELETE CASCADE,
  memory jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by_run_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ai_customer_memory_org_contact_uq
  ON ai_customer_memory(organization_id,contact_id);

CREATE TABLE IF NOT EXISTS ai_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL
    REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id uuid REFERENCES ai_agents(id) ON DELETE SET NULL,
  agent_version_id uuid REFERENCES ai_agent_versions(id) ON DELETE SET NULL,
  agent_version integer,
  conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE,
  channel_id uuid REFERENCES channels(id) ON DELETE SET NULL,
  contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  trigger_source text NOT NULL DEFAULT 'incoming_message',
  trigger_message_id uuid,
  trigger_message_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  idempotency_key text NOT NULL,
  correlation_id uuid,
  mode text NOT NULL,
  status text NOT NULL DEFAULT 'running',
  decision text,
  model text,
  model_used text,
  fallback_used boolean NOT NULL DEFAULT false,
  response_text text,
  final_text text,
  response_meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  confidence numeric(3,2),
  requires_human boolean NOT NULL DEFAULT false,
  handoff_reason text,
  knowledge_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  tool_calls jsonb NOT NULL DEFAULT '[]'::jsonb,
  prompt_meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  total_cost_usd numeric(12,6) NOT NULL DEFAULT 0,
  latency_ms integer,
  steps integer NOT NULL DEFAULT 0,
  error_code text,
  error_message text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS ai_runs_org_idempotency_uq
  ON ai_runs(organization_id,idempotency_key);
CREATE INDEX IF NOT EXISTS ai_runs_org_agent_started_idx
  ON ai_runs(organization_id,agent_id,started_at DESC);
CREATE INDEX IF NOT EXISTS ai_runs_conversation_idx
  ON ai_runs(conversation_id,started_at DESC);
CREATE INDEX IF NOT EXISTS ai_runs_org_started_idx
  ON ai_runs(organization_id,started_at DESC);
CREATE INDEX IF NOT EXISTS ai_runs_agent_version_idx
  ON ai_runs(agent_version_id);
CREATE INDEX IF NOT EXISTS ai_runs_channel_idx
  ON ai_runs(channel_id);
CREATE INDEX IF NOT EXISTS ai_runs_contact_idx
  ON ai_runs(contact_id);

ALTER TABLE ai_runs
  DROP CONSTRAINT IF EXISTS ai_runs_trigger_source_check;
ALTER TABLE ai_runs
  ADD CONSTRAINT ai_runs_trigger_source_check
  CHECK (trigger_source IN
    ('incoming_message','manual','playground','automation','evaluation'));
ALTER TABLE ai_runs
  DROP CONSTRAINT IF EXISTS ai_runs_mode_check;
ALTER TABLE ai_runs
  ADD CONSTRAINT ai_runs_mode_check
  CHECK (mode IN ('observe','copilot','approval','autopilot'));
ALTER TABLE ai_runs
  DROP CONSTRAINT IF EXISTS ai_runs_status_check;
ALTER TABLE ai_runs
  ADD CONSTRAINT ai_runs_status_check
  CHECK (status IN ('running','completed','failed','skipped','cancelled'));
ALTER TABLE ai_runs
  DROP CONSTRAINT IF EXISTS ai_runs_decision_check;
ALTER TABLE ai_runs
  ADD CONSTRAINT ai_runs_decision_check
  CHECK (decision IS NULL OR decision IN
    ('observed','suggested','draft_created','auto_sent','blocked','handoff','skipped'));

CREATE TABLE IF NOT EXISTS ai_run_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL
    REFERENCES organizations(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL
    REFERENCES conversations(id) ON DELETE CASCADE,
  channel_id uuid REFERENCES channels(id) ON DELETE SET NULL,
  contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  agent_id uuid REFERENCES ai_agents(id) ON DELETE SET NULL,
  message_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  dedupe_key text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  not_before timestamptz NOT NULL DEFAULT now(),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  run_id uuid REFERENCES ai_runs(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ai_run_requests_org_dedupe_uq
  ON ai_run_requests(organization_id,dedupe_key);
CREATE INDEX IF NOT EXISTS ai_run_requests_claim_idx
  ON ai_run_requests(next_attempt_at)
  WHERE status IN ('pending','retry');
-- One in-flight request per conversation keeps AI replies strictly serialized.
CREATE UNIQUE INDEX IF NOT EXISTS ai_run_requests_processing_conversation_uq
  ON ai_run_requests(conversation_id)
  WHERE status = 'processing';
CREATE INDEX IF NOT EXISTS ai_run_requests_org_conversation_idx
  ON ai_run_requests(organization_id,conversation_id,created_at DESC);
CREATE INDEX IF NOT EXISTS ai_run_requests_run_idx
  ON ai_run_requests(run_id);

ALTER TABLE ai_run_requests
  DROP CONSTRAINT IF EXISTS ai_run_requests_status_check;
ALTER TABLE ai_run_requests
  ADD CONSTRAINT ai_run_requests_status_check
  CHECK (status IN
    ('pending','processing','retry','completed','failed','skipped','cancelled'));

CREATE TABLE IF NOT EXISTS ai_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL
    REFERENCES organizations(id) ON DELETE CASCADE,
  run_id uuid NOT NULL
    REFERENCES ai_runs(id) ON DELETE CASCADE,
  action text NOT NULL,
  original_text text,
  final_text text,
  comment text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_feedback_org_run_idx
  ON ai_feedback(organization_id,run_id);
CREATE INDEX IF NOT EXISTS ai_feedback_org_created_idx
  ON ai_feedback(organization_id,created_at DESC);

ALTER TABLE ai_feedback
  DROP CONSTRAINT IF EXISTS ai_feedback_action_check;
ALTER TABLE ai_feedback
  ADD CONSTRAINT ai_feedback_action_check
  CHECK (action IN
    ('rated_good','rated_bad','approved','edited','rejected','sent','regenerated'));

CREATE TABLE IF NOT EXISTS ai_training_examples (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL
    REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL
    REFERENCES ai_agents(id) ON DELETE CASCADE,
  source_run_id uuid REFERENCES ai_runs(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending',
  customer_message text NOT NULL,
  context_summary text,
  ai_output text,
  human_output text NOT NULL DEFAULT '',
  intent text,
  language text,
  notes text,
  reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  promoted_to text,
  promoted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_training_examples_org_agent_status_idx
  ON ai_training_examples(organization_id,agent_id,status);
CREATE INDEX IF NOT EXISTS ai_training_examples_source_run_idx
  ON ai_training_examples(source_run_id);

ALTER TABLE ai_training_examples
  DROP CONSTRAINT IF EXISTS ai_training_examples_status_check;
ALTER TABLE ai_training_examples
  ADD CONSTRAINT ai_training_examples_status_check
  CHECK (status IN ('pending','approved','rejected'));
ALTER TABLE ai_training_examples
  DROP CONSTRAINT IF EXISTS ai_training_examples_promoted_to_check;
ALTER TABLE ai_training_examples
  ADD CONSTRAINT ai_training_examples_promoted_to_check
  CHECK (promoted_to IS NULL OR promoted_to IN ('example','knowledge'));

CREATE TABLE IF NOT EXISTS ai_evaluation_datasets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL
    REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id uuid REFERENCES ai_agents(id) ON DELETE SET NULL,
  name text NOT NULL,
  description text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ai_evaluation_datasets_org_name_uq
  ON ai_evaluation_datasets(organization_id,name);
CREATE INDEX IF NOT EXISTS ai_evaluation_datasets_agent_idx
  ON ai_evaluation_datasets(agent_id);

CREATE TABLE IF NOT EXISTS ai_evaluation_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL
    REFERENCES organizations(id) ON DELETE CASCADE,
  dataset_id uuid NOT NULL
    REFERENCES ai_evaluation_datasets(id) ON DELETE CASCADE,
  name text NOT NULL,
  position integer NOT NULL DEFAULT 0,
  input jsonb NOT NULL DEFAULT '[]'::jsonb,
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  expectations jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ai_evaluation_cases_dataset_name_uq
  ON ai_evaluation_cases(dataset_id,name);
CREATE INDEX IF NOT EXISTS ai_evaluation_cases_org_dataset_idx
  ON ai_evaluation_cases(organization_id,dataset_id,position);

CREATE TABLE IF NOT EXISTS ai_evaluation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL
    REFERENCES organizations(id) ON DELETE CASCADE,
  dataset_id uuid NOT NULL
    REFERENCES ai_evaluation_datasets(id) ON DELETE CASCADE,
  agent_id uuid REFERENCES ai_agents(id) ON DELETE SET NULL,
  agent_version_id uuid REFERENCES ai_agent_versions(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'running',
  total_cases integer NOT NULL DEFAULT 0,
  passed_cases integer NOT NULL DEFAULT 0,
  results jsonb NOT NULL DEFAULT '[]'::jsonb,
  score numeric(5,2),
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  total_cost_usd numeric(12,6) NOT NULL DEFAULT 0,
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS ai_evaluation_runs_org_dataset_idx
  ON ai_evaluation_runs(organization_id,dataset_id,started_at DESC);
CREATE INDEX IF NOT EXISTS ai_evaluation_runs_agent_version_idx
  ON ai_evaluation_runs(agent_version_id);
CREATE INDEX IF NOT EXISTS ai_evaluation_runs_agent_idx
  ON ai_evaluation_runs(agent_id);

ALTER TABLE ai_evaluation_runs
  DROP CONSTRAINT IF EXISTS ai_evaluation_runs_status_check;
ALTER TABLE ai_evaluation_runs
  ADD CONSTRAINT ai_evaluation_runs_status_check
  CHECK (status IN ('running','completed','failed','cancelled'));

CREATE TABLE IF NOT EXISTS ai_usage_daily (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL
    REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL
    REFERENCES ai_agents(id) ON DELETE CASCADE,
  day date NOT NULL,
  runs integer NOT NULL DEFAULT 0,
  suggested integer NOT NULL DEFAULT 0,
  drafts integer NOT NULL DEFAULT 0,
  auto_sent integer NOT NULL DEFAULT 0,
  handoffs integer NOT NULL DEFAULT 0,
  failures integer NOT NULL DEFAULT 0,
  input_tokens bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  total_cost_usd numeric(12,6) NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ai_usage_daily_org_agent_day_uq
  ON ai_usage_daily(organization_id,agent_id,day);
CREATE INDEX IF NOT EXISTS ai_usage_daily_agent_idx
  ON ai_usage_daily(agent_id);
