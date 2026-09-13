import type {
  CreateCrmEntity,
  CrmContext,
  CrmHealth,
  CrmMatch,
  CrmMatchInput,
  CrmPage,
  CrmPipeline,
  CrmProvider,
  CrmUser,
  TimelineInput,
} from "./types";
import { BitrixRestClient } from "./bitrix-client";
import { BitrixError, normalizeCrmPhone } from "./utils";

type Row = Record<string, unknown>;

type DuplicateCommunicationResult = Partial<
  Record<"CONTACT" | "LEAD" | "COMPANY", Array<number | string>>
>;

function uniqueExternalIds(values: Array<number | string> | undefined) {
  return [...new Set((values ?? []).map(String).filter(Boolean))];
}

export class Bitrix24Provider implements CrmProvider {
  constructor(
    private readonly client: BitrixRestClient,
    private readonly portal: string,
  ) {}
  async health(): Promise<CrmHealth> {
    await this.client.call("profile");
    return {
      healthy: true,
      portal: this.portal,
      provider: "bitrix24",
      checkedAt: new Date().toISOString(),
    };
  }
  async listUsers(cursor?: string): Promise<CrmPage<CrmUser>> {
    const response = await this.client.call<Row[]>("user.get", {
      start: Number(cursor ?? 0),
    });
    return {
      data: (response.result ?? []).map((row) => ({
        externalId: String(row.ID),
        name: [row.NAME, row.LAST_NAME].filter(Boolean).join(" "),
        email: row.EMAIL ? String(row.EMAIL) : null,
        active: row.ACTIVE !== false && row.ACTIVE !== "N",
      })),
      nextCursor:
        typeof response.next === "number" ? String(response.next) : null,
    };
  }
  async findEntities(input: CrmMatchInput): Promise<CrmMatch[]> {
    const phone = input.phone ? normalizeCrmPhone(input.phone) : null;
    const email = input.email?.trim() || null;
    if (phone) {
      const duplicateResponse =
        await this.client.call<DuplicateCommunicationResult>(
          "crm.duplicate.findbycomm",
          { type: "PHONE", values: [phone] },
        );
      const contactIds = uniqueExternalIds(duplicateResponse.result?.CONTACT);
      const leadIds = uniqueExternalIds(duplicateResponse.result?.LEAD);
      const [contacts, leads] = await Promise.all([
        contactIds.length
          ? this.client.paginate<Row>("crm.contact.list", {
              filter: { "@ID": contactIds },
              select: ["ID", "NAME", "LAST_NAME"],
            })
          : Promise.resolve([]),
        leadIds.length
          ? this.client.paginate<Row>("crm.lead.list", {
              filter: { "@ID": leadIds },
              select: ["ID", "TITLE", "NAME", "LAST_NAME"],
            })
          : Promise.resolve([]),
      ]);
      const contactsById = new Map(
        contacts.map((row) => [String(row.ID), row]),
      );
      const leadsById = new Map(leads.map((row) => [String(row.ID), row]));
      return [
        ...contactIds.map((externalId): CrmMatch => {
          const row = contactsById.get(externalId);
          return {
            entityType: "contact",
            externalId,
            displayName:
              [row?.NAME, row?.LAST_NAME].filter(Boolean).join(" ") ||
              `Contact #${externalId}`,
            confidence: 1,
            source: "phone",
          };
        }),
        ...leadIds.map((externalId): CrmMatch => {
          const row = leadsById.get(externalId);
          return {
            entityType: "lead",
            externalId,
            displayName: String(
              (row?.TITLE ??
                [row?.NAME, row?.LAST_NAME].filter(Boolean).join(" ")) ||
                `Lead #${externalId}`,
            ),
            confidence: 0.95,
            source: "phone",
          };
        }),
      ];
    }
    // An empty filter makes crm.*.list return the whole portal, which would
    // auto-link the conversation to an arbitrary unrelated entity.
    if (!email) return [];
    const filter = { EMAIL: email };
    const [contacts, leads] = await Promise.all([
      this.client.paginate<Row>("crm.contact.list", {
        filter,
        select: ["ID", "NAME", "LAST_NAME"],
      }),
      this.client.paginate<Row>("crm.lead.list", {
        filter,
        select: ["ID", "TITLE", "NAME", "LAST_NAME"],
      }),
    ]);
    const source = "email" as const;
    return [
      ...contacts.map((row): CrmMatch => ({
        entityType: "contact",
        externalId: String(row.ID),
        displayName: [row.NAME, row.LAST_NAME].filter(Boolean).join(" "),
        confidence: 1,
        source,
      })),
      ...leads.map((row): CrmMatch => ({
        entityType: "lead",
        externalId: String(row.ID),
        displayName: String(
          row.TITLE ?? [row.NAME, row.LAST_NAME].filter(Boolean).join(" "),
        ),
        confidence: 0.95,
        source,
      })),
    ];
  }
  async getContext(link: {
    entityType: "contact" | "lead" | "deal" | "company";
    externalId: string;
  }): Promise<CrmContext> {
    const response = await this.client.call<Row>(`crm.${link.entityType}.get`, {
      id: link.externalId,
    });
    if (!response.result)
      throw new BitrixError("NOT_FOUND", false, "Bitrix entity not found");
    const row = response.result;
    return {
      entity: {
        ...link,
        displayName: String(
          row.TITLE ??
            [row.NAME, row.LAST_NAME].filter(Boolean).join(" ") ??
            link.externalId,
        ),
      },
      responsible: row.ASSIGNED_BY_ID
        ? {
            externalId: String(row.ASSIGNED_BY_ID),
            name: String(row.ASSIGNED_BY_NAME ?? row.ASSIGNED_BY_ID),
            email: null,
            active: true,
          }
        : null,
      company: row.COMPANY_TITLE ? String(row.COMPANY_TITLE) : null,
      pipeline: row.CATEGORY_ID ? String(row.CATEGORY_ID) : null,
      stage: row.STAGE_ID ? String(row.STAGE_ID) : null,
      fields: row,
    };
  }
  async createEntity(input: CreateCrmEntity) {
    const response = await this.client.call<
      number | { item?: { id?: number } }
    >(`crm.${input.entityType}.add`, {
      fields: {
        ...input.fields,
        ...(input.pipelineId ? { CATEGORY_ID: input.pipelineId } : {}),
        ...(input.stageId ? { STAGE_ID: input.stageId } : {}),
      },
      params: { REGISTER_SONET_EVENT: "N" },
    });
    const result = response.result;
    const id = typeof result === "number" ? result : result?.item?.id;
    return { entityType: input.entityType, externalId: String(id) };
  }
  async addTimelineComment(input: TimelineInput) {
    // Comments carry no idempotency marker: operators see the timeline, so
    // it must stay clean. Once-only delivery is owned by the crm_sync_jobs
    // idempotency key (a completed job never re-runs); the only remaining
    // duplicate window is a crash between Bitrix's response and the job's
    // completion write, which is milliseconds wide.
    const response = await this.client.call<number>(
      "crm.timeline.comment.add",
      {
        fields: {
          ENTITY_ID: input.externalId,
          ENTITY_TYPE: input.entityType,
          COMMENT: input.text,
          ...(input.attachments?.length
            ? {
                FILES: input.attachments.map((attachment) => [
                  attachment.filename,
                  attachment.contentBase64,
                ]),
              }
            : {}),
        },
      },
    );
    return { externalId: String(response.result) };
  }
  async updateResponsible(input: {
    entityType: "contact" | "lead" | "deal" | "company";
    externalId: string;
    externalUserId: string;
  }) {
    await this.client.call(`crm.${input.entityType}.update`, {
      id: input.externalId,
      fields: { ASSIGNED_BY_ID: input.externalUserId },
    });
  }
  async listPipelines(): Promise<CrmPipeline[]> {
    const categoryResponse = await this.client.call<{
      categories?: Row[];
    }>("crm.category.list", { entityTypeId: 2 });
    const categories = categoryResponse.result?.categories ?? [];
    return Promise.all(
      categories.map(async (category) => {
        const categoryId = Number(category.id ?? category.ID);
        const stageEntityId =
          categoryId === 0 ? "DEAL_STAGE" : `DEAL_STAGE_${categoryId}`;
        const stages = await this.client.paginate<Row>("crm.status.list", {
          order: { SORT: "ASC" },
          filter: { ENTITY_ID: stageEntityId },
        });
        return {
          externalId: String(categoryId),
          name: String(category.name ?? category.NAME),
          entityType: "deal" as const,
          stages: stages.map((stage, index) => ({
            externalId: String(stage.STATUS_ID),
            name: String(stage.NAME),
            order: Number(stage.SORT ?? index),
          })),
        };
      }),
    );
  }
}
