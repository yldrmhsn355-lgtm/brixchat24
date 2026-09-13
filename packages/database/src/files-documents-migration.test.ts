import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(import.meta.dirname, "../migrations/0019_files_documents.sql"),
  "utf8",
);
const followUpMigration = readFileSync(
  resolve(
    import.meta.dirname,
    "../migrations/0020_file_version_storage_key.sql",
  ),
  "utf8",
);

describe("files and documents migration", () => {
  it("creates every tenant-scoped storage aggregate", () => {
    for (const table of [
      "storage_connections",
      "storage_oauth_states",
      "file_assets",
      "contact_storage_folders",
      "file_versions",
      "storage_sync_channels",
      "storage_sync_jobs",
      "file_audit_logs",
      "file_processing_jobs",
    ]) {
      expect(migration).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
      expect(migration).toMatch(
        new RegExp(
          `CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?organization_id uuid NOT NULL`,
        ),
      );
    }
  });

  it("enforces inbound idempotency and soft-delete lookup indexes", () => {
    expect(migration).toContain("file_assets_whatsapp_media_uq");
    expect(migration).toContain(
      "WHERE whatsapp_message_id IS NOT NULL AND provider_media_id IS NOT NULL AND deleted_at IS NULL",
    );
    expect(migration).toContain("file_assets_org_status_created_idx");
    expect(migration).toContain("deleted_at IS NULL");
  });

  it("links message attachments without removing existing media storage", () => {
    expect(migration).toContain(
      "ALTER TABLE message_attachments ADD COLUMN IF NOT EXISTS file_asset_id",
    );
    expect(migration).not.toMatch(/DROP\s+(TABLE|COLUMN)/i);
  });

  it("keeps each immutable version linked to its ingest object", () => {
    expect(followUpMigration).toContain(
      "ADD COLUMN IF NOT EXISTS internal_storage_key text",
    );
    expect(followUpMigration).not.toMatch(/DROP\s+(TABLE|COLUMN)/i);
  });
});
