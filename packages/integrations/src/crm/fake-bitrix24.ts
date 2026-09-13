import { createHash } from "node:crypto";
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
import { BitrixError } from "./utils";

export type FakeBitrixScenario =
  | "success"
  | "empty"
  | "pagination"
  | "ambiguous_contact"
  | "timeout"
  | "auth_failure"
  | "rate_limit"
  | "permission_denied"
  | "invalid_payload"
  | "temporary_error"
  | "permanent_error";
const stableId = (prefix: string, value: string) =>
  `${prefix}-${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;

export class FakeBitrix24Provider implements CrmProvider {
  constructor(private readonly scenario: FakeBitrixScenario = "success") {}
  private fail(): void {
    if (this.scenario === "timeout")
      throw new BitrixError("TIMEOUT", true, "Fake Bitrix timeout");
    if (this.scenario === "auth_failure")
      throw new BitrixError("AUTH", false, "Fake Bitrix auth failure");
    if (this.scenario === "rate_limit")
      throw new BitrixError(
        "RATE_LIMIT",
        true,
        "Fake Bitrix rate limit",
        1_000,
      );
    if (this.scenario === "permission_denied")
      throw new BitrixError(
        "PERMISSION",
        false,
        "Fake Bitrix permission denied",
      );
    if (this.scenario === "invalid_payload")
      throw new BitrixError("VALIDATION", false, "Fake Bitrix invalid payload");
    if (this.scenario === "temporary_error")
      throw new BitrixError("TEMPORARY", true, "Fake Bitrix temporary failure");
    if (this.scenario === "permanent_error")
      throw new BitrixError(
        "PERMANENT",
        false,
        "Fake Bitrix permanent failure",
      );
  }
  async health(): Promise<CrmHealth> {
    this.fail();
    return {
      healthy: true,
      portal: "fake.bitrix24.local",
      provider: "fake",
      checkedAt: new Date().toISOString(),
    };
  }
  async listUsers(cursor?: string): Promise<CrmPage<CrmUser>> {
    this.fail();
    if (this.scenario === "empty") return { data: [], nextCursor: null };
    const users = [
      {
        externalId: "101",
        name: "Ayşe Yılmaz",
        email: "ayse@example.test",
        active: true,
      },
      {
        externalId: "102",
        name: "Mert Kaya",
        email: "mert@example.test",
        active: true,
      },
    ];
    if (this.scenario === "pagination" && !cursor)
      return { data: users.slice(0, 1), nextCursor: "1" };
    return {
      data: this.scenario === "pagination" ? users.slice(1) : users,
      nextCursor: null,
    };
  }
  async findEntities(input: CrmMatchInput): Promise<CrmMatch[]> {
    this.fail();
    if (this.scenario === "empty") return [];
    const source = input.phone ? ("phone" as const) : ("email" as const);
    const first: CrmMatch = {
      entityType: "contact",
      externalId: "501",
      displayName: "Elif Demir",
      confidence: 1,
      source,
    };
    return this.scenario === "ambiguous_contact"
      ? [first, { ...first, externalId: "502", displayName: "Elif Demir (2)" }]
      : [first];
  }
  async getContext(link: {
    entityType: "contact" | "lead" | "deal" | "company";
    externalId: string;
  }): Promise<CrmContext> {
    this.fail();
    return {
      entity: { ...link, displayName: "Elif Demir" },
      responsible: {
        externalId: "101",
        name: "Ayşe Yılmaz",
        email: "ayse@example.test",
        active: true,
      },
      company: "Brix Dental",
      pipeline: "Satış",
      stage: "Yeni",
      fields: { SOURCE_ID: "WHATSAPP" },
    };
  }
  async createEntity(input: CreateCrmEntity) {
    this.fail();
    return {
      entityType: input.entityType,
      externalId: stableId(input.entityType, input.idempotencyKey),
    };
  }
  async addTimelineComment(input: TimelineInput) {
    this.fail();
    return { externalId: stableId("timeline", input.idempotencyKey) };
  }
  async updateResponsible() {
    this.fail();
  }
  async listPipelines(): Promise<CrmPipeline[]> {
    this.fail();
    return this.scenario === "empty"
      ? []
      : [
          {
            externalId: "0",
            name: "Satış",
            entityType: "deal",
            stages: [
              { externalId: "NEW", name: "Yeni", order: 10 },
              { externalId: "WON", name: "Kazanıldı", order: 20 },
            ],
          },
        ];
  }
}
