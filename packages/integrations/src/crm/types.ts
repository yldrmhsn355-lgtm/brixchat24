export type CrmEntityType = "contact" | "lead" | "deal" | "company";
export type CrmErrorCode =
  | "AUTH"
  | "PERMISSION"
  | "RATE_LIMIT"
  | "TIMEOUT"
  | "VALIDATION"
  | "NOT_FOUND"
  | "TEMPORARY"
  | "PERMANENT";

export interface CrmPage<T> {
  data: T[];
  nextCursor: string | null;
}
export interface CrmHealth {
  healthy: boolean;
  portal: string;
  provider: "bitrix24" | "fake";
  checkedAt: string;
}
export interface CrmUser {
  externalId: string;
  name: string;
  email: string | null;
  active: boolean;
}
export interface CrmMatchInput {
  phone?: string;
  email?: string;
}
export interface CrmMatch {
  entityType: CrmEntityType;
  externalId: string;
  displayName: string;
  confidence: number;
  source: "phone" | "email";
}
export interface CrmLink {
  entityType: CrmEntityType;
  externalId: string;
}
export interface CrmContext {
  entity: CrmLink & { displayName: string };
  responsible: CrmUser | null;
  company: string | null;
  pipeline: string | null;
  stage: string | null;
  fields: Record<string, unknown>;
}
export interface CreateCrmEntity {
  entityType: Exclude<CrmEntityType, "company">;
  idempotencyKey: string;
  fields: Record<string, unknown>;
  pipelineId?: string;
  stageId?: string;
}
export interface CrmEntityRef {
  entityType: CrmEntityType;
  externalId: string;
}
export interface TimelineInput extends CrmLink {
  text: string;
  idempotencyKey: string;
  attachments?: Array<{
    filename: string;
    contentBase64: string;
  }>;
}
export interface CrmPipelineStage {
  externalId: string;
  name: string;
  order: number;
}
export interface CrmPipeline {
  externalId: string;
  name: string;
  entityType: "lead" | "deal";
  stages: CrmPipelineStage[];
}

export interface CrmProvider {
  health(): Promise<CrmHealth>;
  listUsers(cursor?: string): Promise<CrmPage<CrmUser>>;
  findEntities(input: CrmMatchInput): Promise<CrmMatch[]>;
  getContext(link: CrmLink): Promise<CrmContext>;
  createEntity(input: CreateCrmEntity): Promise<CrmEntityRef>;
  addTimelineComment(input: TimelineInput): Promise<{ externalId: string }>;
  updateResponsible(
    input: CrmLink & { externalUserId: string; idempotencyKey: string },
  ): Promise<void>;
  listPipelines(): Promise<CrmPipeline[]>;
}
