import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import {
  CampaignRepository,
  type CampaignDraftInput,
  type CampaignDryRun,
} from "./campaigns";
import { createScopedDatabaseRouter } from "../scoped-router";

const url = process.env.SCOPED_ROUTER_TEST_DATABASE_URL;
describe.skipIf(!url)("campaign persistence in isolated PostgreSQL", () => {
  const sql = postgres(url!, { max: 4, onnotice: () => {} });
  const repository = new CampaignRepository(sql);
  const organizationId = randomUUID(),
    userId = randomUUID(),
    channelId = randomUUID();
  let verified = false;
  const input = (): CampaignDraftInput => ({
    organizationId,
    userId,
    channelId,
    name: "Dry-run test",
    requestKey: randomUUID(),
    content: { type: "text", text: "Test ön izlemesi" },
    recipients: [{ phone: "+15551234567", name: "Test" }],
  });
  const passed: CampaignDryRun = {
    recipientCount: 1,
    eligibleCount: 1,
    blockedCount: 0,
    blockers: [],
    recipients: [],
    messagePreview: "Test",
    messagesQueued: 0,
  };
  beforeAll(async () => {
    if (!/restore|test/.test(new URL(url!).pathname))
      throw new Error("ISOLATED_TEST_DATABASE_REQUIRED");
    verified = true;
    await sql`INSERT INTO organizations(id,name,slug) VALUES(${organizationId},'Campaign tests',${organizationId})`;
    await sql`INSERT INTO users(id,email,full_name,password_hash) VALUES(${userId},${`${userId}@example.invalid`},'Test Manager','test-account-login-disabled')`;
    await sql`INSERT INTO organization_members(organization_id,user_id,role) VALUES(${organizationId},${userId},'owner')`;
    await sql`INSERT INTO channels(id,organization_id,name,provider,status) VALUES(${channelId},${organizationId},'Test line','meta','connected')`;
  });
  afterAll(async () => {
    if (verified) {
      await sql`DELETE FROM campaigns WHERE organization_id=${organizationId}`;
      await sql`DELETE FROM organizations WHERE id=${organizationId}`;
      await sql`DELETE FROM users WHERE id=${userId}`;
    }
    await sql.end();
  });
  it("serializes concurrent create retries and rejects reuse with different content", async () => {
    const draft = input();
    const results = await Promise.all([
      repository.createDraft(draft),
      repository.createDraft(draft),
    ]);
    expect(results[0]!.campaign.id).toBe(results[1]!.campaign.id);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    await expect(
      repository.createDraft({ ...draft, name: "Different" }),
    ).rejects.toThrow("campaign_idempotency_conflict");
  });
  it("requires a connected line and distinct valid recipients", async () => {
    await expect(
      repository.createDraft({ ...input(), channelId: randomUUID() }),
    ).rejects.toThrow("campaign_connected_channel_required");
    await expect(
      repository.createDraft({
        ...input(),
        recipients: [{ phone: "05551234567", name: "" }],
      }),
    ).rejects.toThrow("campaign_recipient_invalid");
    const draft = input();
    await expect(
      repository.createDraft({
        ...draft,
        recipients: [...draft.recipients, ...draft.recipients],
      }),
    ).rejects.toThrow("campaign_duplicate_recipient");
  });
  it("requires a current manager, not merely a same-tenant user identifier", async () => {
    await expect(
      repository.createDraft({ ...input(), userId: randomUUID() }),
    ).rejects.toThrow("campaign_manager_required");
  });
  it.skipIf(!process.env.API_SCOPED_TEST_DATABASE_URL)(
    "enforces tenant RLS for campaign creation and unfiltered reads",
    async () => {
      const scopedUrl = process.env.API_SCOPED_TEST_DATABASE_URL!;
      if (new URL(scopedUrl).pathname !== new URL(url!).pathname)
        throw new Error("TEST_DATABASE_MISMATCH");
      const pool = postgres(scopedUrl, { max: 2 });
      const router = createScopedDatabaseRouter(pool);
      try {
        const repo = new CampaignRepository(router.sql);
        await router.tenant(
          organizationId,
          async () => {
            const created = await repo.createDraft(input());
            expect(created.created).toBe(true);
            const rows =
              await router.sql`SELECT organization_id FROM campaign_recipients`;
            expect(rows.length).toBeGreaterThan(0);
            expect(
              rows.every((row) => row.organization_id === organizationId),
            ).toBe(true);
          },
          userId,
        );
        await router.tenant(randomUUID(), async () => {
          expect(await router.sql`SELECT id FROM campaigns`).toHaveLength(0);
          expect(
            await router.sql`SELECT id FROM campaign_recipients`,
          ).toHaveLength(0);
        });
      } finally {
        await pool.end();
      }
    },
  );
  it("dry-run adds no messages or outbox jobs and cannot start with another token", async () => {
    const { campaign } = await repository.createDraft(input());
    const dry = await repository.dryRun(
      organizationId,
      campaign.id,
      userId,
      async () => passed,
    );
    const counts =
      await sql`SELECT (SELECT count(*) FROM messages WHERE organization_id=${organizationId}) messages,
      (SELECT count(*) FROM outbox_jobs WHERE organization_id=${organizationId}) jobs`;
    expect(Number(counts[0]!.messages)).toBe(0);
    expect(Number(counts[0]!.jobs)).toBe(0);
    await expect(
      repository.start(organizationId, campaign.id, userId, randomUUID(), 1),
    ).rejects.toThrow("campaign_dry_run_required");
    await expect(
      repository.start(organizationId, campaign.id, userId, dry.token, 2),
    ).rejects.toThrow("campaign_confirmation_mismatch");
    const started = await Promise.all(
      [1, 2].map(() =>
        repository.start(organizationId, campaign.id, userId, dry.token, 1),
      ),
    );
    expect(started.filter((result) => result.started)).toHaveLength(1);
  });
  it("rejects blocked and expired dry-runs", async () => {
    const { campaign } = await repository.createDraft(input());
    const blocked = await repository.dryRun(
      organizationId,
      campaign.id,
      userId,
      async () => ({ ...passed, blockers: ["channel_disconnected"] }),
    );
    await expect(
      repository.start(organizationId, campaign.id, userId, blocked.token, 1),
    ).rejects.toThrow("campaign_dry_run_blocked");
    const fresh = await repository.dryRun(
      organizationId,
      campaign.id,
      userId,
      async () => passed,
    );
    await sql`UPDATE campaigns SET dry_run_at=now()-interval '11 minutes' WHERE id=${campaign.id}`;
    await expect(
      repository.start(organizationId, campaign.id, userId, fresh.token, 1),
    ).rejects.toThrow("campaign_dry_run_expired");
  });
  it("cancel prevents all pending recipients from being enqueued", async () => {
    const { campaign } = await repository.createDraft(input());
    const dry = await repository.dryRun(
      organizationId,
      campaign.id,
      userId,
      async () => passed,
    );
    await repository.cancel(organizationId, campaign.id, userId);
    expect(
      (await repository.recipients(organizationId, campaign.id))[0]!.status,
    ).toBe("canceled");
    await expect(
      repository.start(organizationId, campaign.id, userId, dry.token, 1),
    ).rejects.toThrow("campaign_canceled");
  });

  it("evaluates real consent and window state, then enqueues once under concurrent workers", async () => {
    // Discard pending drafts from earlier approval-state tests; no worker is connected to this DB.
    await sql`UPDATE campaigns SET status='canceled' WHERE organization_id=${organizationId}`;
    const { campaign } = await repository.createDraft(input());
    const blocked = await repository.dryRun(
      organizationId,
      campaign.id,
      userId,
    );
    expect(blocked.recipients[0]!.reason).toBe("whatsapp_opt_in_missing");
    await sql`INSERT INTO consent_records(organization_id,subject_reference_hash,purpose,status,source)
      VALUES(${organizationId},encode(sha256(convert_to('+15551234567','UTF8')),'hex'),'whatsapp','granted','isolated-test')`;
    const windowBlocked = await repository.dryRun(
      organizationId,
      campaign.id,
      userId,
    );
    expect(windowBlocked.recipients[0]!.reason).toBe(
      "WHATSAPP_TEMPLATE_REQUIRED",
    );
    const [contact] =
      await sql`INSERT INTO contacts(organization_id,first_name,normalized_phone)
      VALUES(${organizationId},'Test','+15551234567') RETURNING id`;
    await sql`INSERT INTO conversations(organization_id,channel_id,contact_id,status,customer_service_window_expires_at)
      VALUES(${organizationId},${channelId},${contact!.id},'open',now()+interval '1 hour')`;
    const dry = await repository.dryRun(organizationId, campaign.id, userId);
    expect(dry.blockers).toEqual([]);
    expect(dry.eligibleCount).toBe(1);
    await repository.start(organizationId, campaign.id, userId, dry.token, 1);
    await Promise.all([
      repository.processNextRecipient(),
      repository.processNextRecipient(),
    ]);
    const [counts] =
      await sql`SELECT (SELECT count(*) FROM messages WHERE organization_id=${organizationId}) messages,
      (SELECT count(*) FROM outbox_jobs WHERE organization_id=${organizationId}) jobs`;
    expect(Number(counts!.messages)).toBe(1);
    expect(Number(counts!.jobs)).toBe(1);
    const [recipient] = await repository.recipients(
      organizationId,
      campaign.id,
    );
    expect(recipient!.status).toBe("queued");
    const messageId = String(recipient!.message_id);
    const attempts = await Promise.all([
      repository.beginDelivery(organizationId, messageId),
      repository.beginDelivery(organizationId, messageId),
    ]);
    expect(attempts.filter(Boolean)).toHaveLength(1);
    // Simulated acknowledgement only; there is deliberately no provider request.
    await sql`UPDATE messages SET status='sent' WHERE id=${messageId}`;
    await repository.reconcileStatuses();
    expect(
      (await repository.recipients(organizationId, campaign.id))[0]!.status,
    ).toBe("sent");
    expect((await repository.get(organizationId, campaign.id)).status).toBe(
      "completed",
    );
  });

  it("rechecks consent after approval and fails the recipient without creating a message", async () => {
    const { campaign } = await repository.createDraft(input());
    const dry = await repository.dryRun(organizationId, campaign.id, userId);
    await repository.start(organizationId, campaign.id, userId, dry.token, 1);
    await sql`UPDATE consent_records SET status='withdrawn',withdrawn_at=now() WHERE organization_id=${organizationId}`;
    await repository.processNextRecipient();
    const [recipient] = await repository.recipients(
      organizationId,
      campaign.id,
    );
    expect(recipient!.status).toBe("failed");
    expect(recipient!.error_code).toBe("whatsapp_opt_in_missing");
    expect(recipient!.message_id).toBeNull();
  });

  it("uses an approved template outside the window and refuses delivery after cancellation", async () => {
    await sql`UPDATE consent_records SET status='granted',withdrawn_at=NULL WHERE organization_id=${organizationId}`;
    await sql`UPDATE conversations SET customer_service_window_expires_at=now()-interval '1 day' WHERE organization_id=${organizationId}`;
    const [template] =
      await sql`INSERT INTO message_templates(organization_id,channel_id,provider,name,language,category,status,body_text)
      VALUES(${organizationId},${channelId},'meta','campaign_test','tr','MARKETING','approved','Test şablonu') RETURNING id`;
    await sql`INSERT INTO message_template_channels(organization_id,template_id,channel_id) VALUES(${organizationId},${template!.id},${channelId})`;
    const { campaign } = await repository.createDraft({
      ...input(),
      content: {
        type: "template",
        templateId: String(template!.id),
        variables: {},
      },
    });
    const dry = await repository.dryRun(organizationId, campaign.id, userId);
    expect(dry.eligibleCount).toBe(1);
    expect(dry.messagePreview).toBe("Test şablonu");
    expect(dry.blockers).toEqual([]);
    await repository.start(organizationId, campaign.id, userId, dry.token, 1);
    await repository.processNextRecipient();
    const [recipient] = await repository.recipients(
      organizationId,
      campaign.id,
    );
    expect(recipient!.status).toBe("queued");
    const [message] =
      await sql`SELECT type,metadata FROM messages WHERE id=${String(recipient!.message_id)}`;
    expect(message!.type).toBe("template");
    expect(message!.metadata.templateName).toBe("campaign_test");
    await repository.cancel(organizationId, campaign.id, userId);
    expect(
      await repository.beginDelivery(
        organizationId,
        String(recipient!.message_id),
      ),
    ).toBe(false);
  });
});
