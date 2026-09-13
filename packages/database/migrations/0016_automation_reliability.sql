ALTER TABLE automation_events
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_attempts integer NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS last_error_code text;

ALTER TABLE automation_events
  DROP CONSTRAINT IF EXISTS automation_events_attempt_bounds_check;
ALTER TABLE automation_events
  ADD CONSTRAINT automation_events_attempt_bounds_check
  CHECK(attempt_count >= 0 AND max_attempts BETWEEN 1 AND 20);

DROP INDEX IF EXISTS automation_events_claim_idx;
CREATE INDEX automation_events_claim_idx
  ON automation_events(status,next_attempt_at,locked_at,created_at)
  WHERE status IN ('pending','retry','processing');
