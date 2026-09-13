import type {
  CrmEntityRef,
  CrmEntityType,
  CrmProvider,
} from "../crm/types";
import { pickUnambiguousMatch } from "../crm/utils";

export type OpenChannelsAutoCrmMode =
  | "disabled"
  | "lead"
  | "contact_and_deal";

export interface OpenChannelsAutoCrmSettings {
  mode: OpenChannelsAutoCrmMode;
  sourceId?: string;
  responsibleExternalUserId?: string | null;
  pipelineId?: string;
  stageId?: string;
}

export type OpenChannelsUserCrmPolicy = {
  mode?: "inherit" | OpenChannelsAutoCrmMode;
  sourceId?: string | undefined;
};

export function resolveOpenChannelsAutoCrmSettings(input: {
  direction: string;
  channel: OpenChannelsAutoCrmSettings;
  userPolicy?: OpenChannelsUserCrmPolicy | null;
  mappedExternalUserId?: string | null;
}): OpenChannelsAutoCrmSettings {
  const policyMode = input.userPolicy?.mode ?? "inherit";
  if (input.direction !== "outbound" || policyMode === "inherit")
    return input.channel;
  const sourceId = input.userPolicy?.sourceId?.trim() || input.channel.sourceId;
  const responsibleExternalUserId =
    input.mappedExternalUserId ?? input.channel.responsibleExternalUserId;
  return {
    ...input.channel,
    mode: policyMode,
    ...(sourceId ? { sourceId } : {}),
    ...(responsibleExternalUserId !== undefined
      ? { responsibleExternalUserId }
      : {}),
  };
}

export interface OpenChannelsCrmLink {
  entityType: CrmEntityType;
  externalId: string;
  matchSource: "phone" | "created" | "inherited";
}

export function openChannelsCustomerLockKey(input: {
  organizationId: string;
  connectionId: string;
  normalizedPhone: string;
}) {
  return [
    "open-channels-crm",
    input.organizationId,
    input.connectionId,
    input.normalizedPhone,
  ].join(":");
}

export function resolveReusableCustomerLinks(
  links: readonly OpenChannelsCrmLink[],
):
  | { status: "resolved"; links: OpenChannelsCrmLink[] }
  | { status: "manual_review"; reason: "conflicting_local_links" } {
  const distinct = new Map<string, OpenChannelsCrmLink>();
  const externalIdsByType = new Map<CrmEntityType, Set<string>>();
  for (const link of links) {
    distinct.set(`${link.entityType}:${link.externalId}`, link);
    const ids = externalIdsByType.get(link.entityType) ?? new Set<string>();
    ids.add(link.externalId);
    externalIdsByType.set(link.entityType, ids);
  }
  if ([...externalIdsByType.values()].some((ids) => ids.size > 1))
    return { status: "manual_review", reason: "conflicting_local_links" };
  return { status: "resolved", links: [...distinct.values()] };
}

export interface OpenChannelsCrmCustomer {
  conversationId: string;
  displayName: string;
  normalizedPhone: string;
  email?: string | null;
}

export type OpenChannelsAutoCrmResult =
  | { status: "completed"; reason: "disabled" | "existing" | "created" }
  | { status: "manual_review"; reason: "ambiguous_match" };

export async function matchOpenChannelsCustomerToExistingCrm(input: {
  provider: CrmProvider;
  customer: OpenChannelsCrmCustomer;
  linkEntity: (entity: CrmEntityRef, source: "phone") => Promise<void>;
}): Promise<
  | { status: "completed"; reason: "existing" }
  | { status: "not_found" }
  | { status: "manual_review"; reason: "ambiguous_match" }
> {
  const matches = await input.provider.findEntities({
    phone: input.customer.normalizedPhone,
    ...(input.customer.email ? { email: input.customer.email } : {}),
  });
  const selected = pickUnambiguousMatch(matches);
  if (!selected && matches.length)
    return { status: "manual_review", reason: "ambiguous_match" };
  if (!selected) return { status: "not_found" };
  await input.linkEntity(
    {
      entityType: selected.entityType,
      externalId: selected.externalId,
    },
    "phone",
  );
  return { status: "completed", reason: "existing" };
}

export async function syncOpenChannelsCustomerToCrm(input: {
  provider: CrmProvider;
  settings: OpenChannelsAutoCrmSettings;
  customer: OpenChannelsCrmCustomer;
  existingLinks: readonly OpenChannelsCrmLink[];
  linkEntity: (
    entity: CrmEntityRef,
    source: "phone" | "created" | "inherited",
  ) => Promise<void>;
  markEntityUnavailable: (entity: CrmEntityRef) => Promise<void>;
}): Promise<OpenChannelsAutoCrmResult> {
  const {
    provider,
    settings,
    customer,
    existingLinks,
    linkEntity,
    markEntityUnavailable,
  } = input;
  if (settings.mode === "disabled")
    return { status: "completed", reason: "disabled" };

  const activeLinks: OpenChannelsCrmLink[] = [];
  for (const link of existingLinks) {
    try {
      await provider.getContext(link);
      activeLinks.push(link);
    } catch (error) {
      const code =
        typeof error === "object" && error !== null
          ? String((error as { code?: unknown }).code ?? "")
          : "";
      if (code !== "NOT_FOUND") throw error;
      await markEntityUnavailable(link);
    }
  }

  const existingLead = activeLinks.find((link) => link.entityType === "lead");
  const existingDeal = activeLinks.find((link) => link.entityType === "deal");
  const existingContact = activeLinks.find(
    (link) => link.entityType === "contact",
  );
  if (existingLead || existingDeal)
    return { status: "completed", reason: "existing" };

  const sourceId = settings.sourceId ?? "WEB";
  const assignedBy = settings.responsibleExternalUserId
    ? { ASSIGNED_BY_ID: settings.responsibleExternalUserId }
    : {};
  const commonFields = {
    NAME: customer.displayName,
    PHONE: [{ VALUE: customer.normalizedPhone, VALUE_TYPE: "MOBILE" }],
    SOURCE_ID: sourceId,
    ...assignedBy,
  };

  // A previous attempt may have persisted the contact before deal creation
  // failed. Resume from that durable boundary and create only the missing deal.
  if (
    existingContact &&
    settings.mode === "contact_and_deal" &&
    existingContact.matchSource === "created"
  ) {
    if (!settings.pipelineId || !settings.stageId)
      throw new Error("OPEN_CHANNELS_CRM_CONFIGURATION_INVALID");
    const deal = await provider.createEntity({
      entityType: "deal",
      idempotencyKey: `open-channels:${customer.conversationId}:deal`,
      fields: {
        TITLE: customer.displayName,
        CONTACT_ID: existingContact.externalId,
        SOURCE_ID: sourceId,
        ...assignedBy,
      },
      pipelineId: settings.pipelineId,
      stageId: settings.stageId,
    });
    await linkEntity(deal, "created");
    return { status: "completed", reason: "created" };
  }
  // Known limitation: if a crash landed between the Bitrix contact create
  // and linkEntity, the retry re-finds that contact by phone and it is
  // indistinguishable from a genuinely pre-existing contact — which by
  // design gets no deal (see "reuses one unambiguous phone match" test).
  // Distinguishing the orphan would require stamping ORIGIN_ID at create
  // time and matching on it; that is a product decision, not a bug fix.
  if (existingContact)
    return { status: "completed", reason: "existing" };

  const match = await matchOpenChannelsCustomerToExistingCrm({
    provider,
    customer,
    linkEntity,
  });
  if (match.status !== "not_found") return match;

  if (settings.mode === "lead") {
    const lead = await provider.createEntity({
      entityType: "lead",
      idempotencyKey: `open-channels:${customer.conversationId}:lead`,
      fields: { ...commonFields, TITLE: customer.displayName },
    });
    await linkEntity(lead, "created");
    return { status: "completed", reason: "created" };
  }

  if (!settings.pipelineId || !settings.stageId)
    throw new Error("OPEN_CHANNELS_CRM_CONFIGURATION_INVALID");
  const contact = await provider.createEntity({
    entityType: "contact",
    idempotencyKey: `open-channels:${customer.conversationId}:contact`,
    fields: commonFields,
  });
  await linkEntity(contact, "created");
  const deal = await provider.createEntity({
    entityType: "deal",
    idempotencyKey: `open-channels:${customer.conversationId}:deal`,
    fields: {
      TITLE: customer.displayName,
      CONTACT_ID: contact.externalId,
      SOURCE_ID: sourceId,
      ...assignedBy,
    },
    pipelineId: settings.pipelineId,
    stageId: settings.stageId,
  });
  await linkEntity(deal, "created");
  return { status: "completed", reason: "created" };
}
