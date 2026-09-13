ALTER TABLE file_versions
  ADD COLUMN IF NOT EXISTS internal_storage_key text;

CREATE INDEX IF NOT EXISTS file_versions_internal_storage_key_idx
  ON file_versions(organization_id,internal_storage_key)
  WHERE internal_storage_key IS NOT NULL;
