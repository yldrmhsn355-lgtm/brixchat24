import { describe, expect, it, vi } from "vitest";
import type { CrmMatch, CrmProvider } from "../crm/types";
import {
  openChannelsCustomerLockKey,
  resolveReusableCustomerLinks,
  syncOpenChannelsCustomerToCrm,
  type OpenChannelsCrmLink,
} from "./auto-crm";

function providerWith(matches: CrmMatch[] = []) {
  const createEntity = vi
    .fn<CrmProvider["createEntity"]>()
    .mockImplementation(async (input) => ({
      entityType: input.entityType,
      externalId:
        input.entityType === "contact"
          ? "contact-101"
          : input.entityType === "deal"
            ? "deal-202"
            : "lead-303",
    }));
  const provider = {
    findEntities: vi.fn(async () => matches),
    createEntity,
    getContext: vi.fn(async (link) => ({
      entity: { ...link, displayName: "Existing CRM entity" },
      responsible: null,
      company: null,
      pipeline: null,
      stage: null,
      fields: { ID: link.externalId },
    })),
  } as unknown as CrmProvider;
  return { provider, createEntity };
}

const customer = {
  conversationId: "conversation-1",
  displayName: "Yeni Müşteri",
  normalizedPhone: "+905551112233",
};

describe("Open Channels automatic CRM registration", () => {
  it("uses one lock identity across conversations and channels", () => {
    const base = {
      organizationId: "workspace-1",
      connectionId: "bitrix-1",
      normalizedPhone: "+905551112233",
    };
    expect(openChannelsCustomerLockKey(base)).toBe(
      openChannelsCustomerLockKey({ ...base }),
    );
    expect(openChannelsCustomerLockKey(base)).not.toBe(
      openChannelsCustomerLockKey({ ...base, connectionId: "bitrix-2" }),
    );
  });

  it("deduplicates reusable links and refuses conflicting local identities", () => {
    expect(
      resolveReusableCustomerLinks([
        { entityType: "contact", externalId: "7", matchSource: "phone" },
        { entityType: "contact", externalId: "7", matchSource: "inherited" },
      ]),
    ).toMatchObject({ status: "resolved", links: [{ externalId: "7" }] });
    expect(
      resolveReusableCustomerLinks([
        { entityType: "lead", externalId: "11", matchSource: "created" },
        { entityType: "lead", externalId: "12", matchSource: "inherited" },
      ]),
    ).toEqual({
      status: "manual_review",
      reason: "conflicting_local_links",
    });
  });

  it("reuses one unambiguous phone match without creating a CRM entity", async () => {
    const { provider, createEntity } = providerWith([
      {
        entityType: "contact",
        externalId: "contact-7",
        displayName: "Kayıtlı Müşteri",
        confidence: 1,
        source: "phone",
      },
    ]);
    const links: OpenChannelsCrmLink[] = [];

    const result = await syncOpenChannelsCustomerToCrm({
      provider,
      settings: { mode: "contact_and_deal" },
      customer,
      existingLinks: [],
      linkEntity: async (entity, matchSource) => {
        links.push({ ...entity, matchSource });
      },
      markEntityUnavailable: vi.fn(),
    });

    expect(result).toEqual({ status: "completed", reason: "existing" });
    expect(createEntity).not.toHaveBeenCalled();
    expect(links).toEqual([
      {
        entityType: "contact",
        externalId: "contact-7",
        matchSource: "phone",
      },
    ]);
  });

  it("creates and links one lead for an unknown phone", async () => {
    const { provider, createEntity } = providerWith();
    const links: OpenChannelsCrmLink[] = [];

    const result = await syncOpenChannelsCustomerToCrm({
      provider,
      settings: { mode: "lead", sourceId: "WEB" },
      customer,
      existingLinks: [],
      linkEntity: async (entity, matchSource) => {
        links.push({ ...entity, matchSource });
      },
      markEntityUnavailable: vi.fn(),
    });

    expect(result).toEqual({ status: "completed", reason: "created" });
    expect(createEntity).toHaveBeenCalledOnce();
    expect(createEntity).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: "lead",
        idempotencyKey: "open-channels:conversation-1:lead",
        fields: expect.objectContaining({
          PHONE: [{ VALUE: "+905551112233", VALUE_TYPE: "MOBILE" }],
        }),
      }),
    );
    expect(links[0]).toMatchObject({
      entityType: "lead",
      externalId: "lead-303",
      matchSource: "created",
    });
  });

  it("creates a contact and a linked deal in the configured stage", async () => {
    const { provider, createEntity } = providerWith();
    const links: OpenChannelsCrmLink[] = [];

    const result = await syncOpenChannelsCustomerToCrm({
      provider,
      settings: {
        mode: "contact_and_deal",
        pipelineId: "8",
        stageId: "C8:NEW",
      },
      customer,
      existingLinks: [],
      linkEntity: async (entity, matchSource) => {
        links.push({ ...entity, matchSource });
      },
      markEntityUnavailable: vi.fn(),
    });

    expect(result).toEqual({ status: "completed", reason: "created" });
    expect(createEntity).toHaveBeenCalledTimes(2);
    expect(createEntity).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        entityType: "deal",
        pipelineId: "8",
        stageId: "C8:NEW",
        fields: expect.objectContaining({ CONTACT_ID: "contact-101" }),
      }),
    );
    expect(links.map((link) => link.entityType)).toEqual(["contact", "deal"]);
  });

  it("moves an ambiguous phone match to manual review without creating data", async () => {
    const matches: CrmMatch[] = ["11", "12"].map((externalId) => ({
      entityType: "contact",
      externalId,
      displayName: `Müşteri ${externalId}`,
      confidence: 1,
      source: "phone",
    }));
    const { provider, createEntity } = providerWith(matches);

    const result = await syncOpenChannelsCustomerToCrm({
      provider,
      settings: { mode: "lead" },
      customer,
      existingLinks: [],
      linkEntity: vi.fn(),
      markEntityUnavailable: vi.fn(),
    });

    expect(result).toEqual({
      status: "manual_review",
      reason: "ambiguous_match",
    });
    expect(createEntity).not.toHaveBeenCalled();
  });

  it("resumes after contact creation and retries only the missing deal", async () => {
    const { provider, createEntity } = providerWith();
    const links: OpenChannelsCrmLink[] = [];

    await syncOpenChannelsCustomerToCrm({
      provider,
      settings: {
        mode: "contact_and_deal",
        pipelineId: "8",
        stageId: "C8:NEW",
      },
      customer,
      existingLinks: [
        {
          entityType: "contact",
          externalId: "contact-existing",
          matchSource: "created",
        },
      ],
      linkEntity: async (entity, matchSource) => {
        links.push({ ...entity, matchSource });
      },
      markEntityUnavailable: vi.fn(),
    });

    expect(createEntity).toHaveBeenCalledOnce();
    expect(createEntity).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: "deal",
        idempotencyKey: "open-channels:conversation-1:deal",
        fields: expect.objectContaining({ CONTACT_ID: "contact-existing" }),
      }),
    );
    expect(links).toEqual([
      {
        entityType: "deal",
        externalId: "deal-202",
        matchSource: "created",
      },
    ]);
  });

  it("marks a deleted lead unavailable and creates a replacement", async () => {
    const { provider, createEntity } = providerWith();
    const markEntityUnavailable = vi.fn(async () => undefined);
    vi.mocked(provider.getContext).mockRejectedValueOnce(
      Object.assign(new Error("Bitrix entity not found"), {
        code: "NOT_FOUND",
      }),
    );

    const result = await syncOpenChannelsCustomerToCrm({
      provider,
      settings: { mode: "lead", sourceId: "WEB" },
      customer,
      existingLinks: [
        {
          entityType: "lead",
          externalId: "lead-deleted",
          matchSource: "created",
        },
      ],
      linkEntity: vi.fn(),
      markEntityUnavailable,
    });

    expect(result).toEqual({ status: "completed", reason: "created" });
    expect(markEntityUnavailable).toHaveBeenCalledWith({
      entityType: "lead",
      externalId: "lead-deleted",
      matchSource: "created",
    });
    expect(createEntity).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: "lead",
        idempotencyKey: "open-channels:conversation-1:lead",
      }),
    );
  });
});
