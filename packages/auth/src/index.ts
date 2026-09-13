import { createHash, randomBytes } from "node:crypto";
import { Algorithm, Version, hash, verify } from "@node-rs/argon2";

export const roles = [
  "owner",
  "admin",
  "team_lead",
  "agent",
  "viewer",
] as const;
export type Role = (typeof roles)[number];
export type Permission =
  | "inbox:read"
  | "message:send"
  | "conversation:assign"
  | "conversation:operate"
  | "conversation:bulk"
  | "conversation:notes"
  | "conversation:export"
  | "labels:read"
  | "labels:assign"
  | "labels:create_team"
  | "labels:create_workspace"
  | "labels:update"
  | "labels:archive"
  | "labels:delete"
  | "labels:merge"
  | "labels:bulk"
  | "labels:categories"
  | "labels:mappings"
  | "labels:analytics"
  | "labels:manage"
  | "views:manage"
  | "integrations:manage"
  | "crm:write"
  | "members:manage"
  | "channels:manage"
  | "templates:read"
  | "templates:create"
  | "templates:submit"
  | "templates:update"
  | "templates:delete"
  | "templates:test"
  | "templates:analytics"
  | "templates:sync"
  | "quick_replies:read"
  | "quick_replies:create"
  | "quick_replies:manage_team"
  | "quick_replies:manage_workspace"
  | "quick_replies:analytics"
  | "quick_replies:import_export"
  | "reports:read"
  | "billing:manage"
  | "attachments:read"
  | "attachments:download"
  | "attachments:delete"
  | "attachments:retry"
  | "files:view"
  | "files:upload"
  | "files:download"
  | "files:send"
  | "files:rename"
  | "files:move"
  | "files:share"
  | "files:archive"
  | "files:delete"
  | "files:restore"
  | "files:manage_connections"
  | "files:view_audit"
  | "search:use"
  | "search:notes"
  | "search:bitrix"
  | "automations:read"
  | "automations:create"
  | "automations:update"
  | "automations:publish"
  | "automations:pause"
  | "automations:runs:read"
  | "open_channels:read"
  | "open_channels:manage"
  | "open_channels:test"
  | "retention:read"
  | "retention:manage"
  | "operations:metrics:read"
  | "operations:health:read"
  | "privacy:read"
  | "privacy:manage"
  | "usage:read"
  | "ai:read"
  | "ai:manage"
  | "ai:copilot"
  | "ai:approve"
  | "ai:training";

const grants: Record<Role, ReadonlySet<Permission>> = {
  owner: new Set([
    "inbox:read",
    "message:send",
    "conversation:assign",
    "conversation:operate",
    "conversation:bulk",
    "conversation:notes",
    "conversation:export",
    "labels:read",
    "labels:assign",
    "labels:create_team",
    "labels:create_workspace",
    "labels:update",
    "labels:archive",
    "labels:delete",
    "labels:merge",
    "labels:bulk",
    "labels:categories",
    "labels:mappings",
    "labels:analytics",
    "labels:manage",
    "views:manage",
    "integrations:manage",
    "crm:write",
    "members:manage",
    "channels:manage",
    "templates:read",
    "templates:create",
    "templates:submit",
    "templates:update",
    "templates:delete",
    "templates:test",
    "templates:analytics",
    "templates:sync",
    "quick_replies:read",
    "quick_replies:create",
    "quick_replies:manage_team",
    "quick_replies:manage_workspace",
    "quick_replies:analytics",
    "quick_replies:import_export",
    "reports:read",
    "billing:manage",
    "attachments:read",
    "attachments:download",
    "attachments:delete",
    "attachments:retry",
    "files:view",
    "files:upload",
    "files:download",
    "files:send",
    "files:rename",
    "files:move",
    "files:share",
    "files:archive",
    "files:delete",
    "files:restore",
    "files:manage_connections",
    "files:view_audit",
    "search:use",
    "search:notes",
    "search:bitrix",
    "automations:read",
    "automations:create",
    "automations:update",
    "automations:publish",
    "automations:pause",
    "automations:runs:read",
    "open_channels:read",
    "open_channels:manage",
    "open_channels:test",
    "retention:read",
    "retention:manage",
    "operations:metrics:read",
    "operations:health:read",
    "privacy:read",
    "privacy:manage",
    "usage:read",
    "ai:read",
    "ai:manage",
    "ai:copilot",
    "ai:approve",
    "ai:training",
  ]),
  admin: new Set([
    "inbox:read",
    "message:send",
    "conversation:assign",
    "conversation:operate",
    "conversation:bulk",
    "conversation:notes",
    "conversation:export",
    "labels:read",
    "labels:assign",
    "labels:create_team",
    "labels:create_workspace",
    "labels:update",
    "labels:archive",
    "labels:delete",
    "labels:merge",
    "labels:bulk",
    "labels:categories",
    "labels:mappings",
    "labels:analytics",
    "labels:manage",
    "views:manage",
    "integrations:manage",
    "crm:write",
    "members:manage",
    "channels:manage",
    "templates:read",
    "templates:create",
    "templates:submit",
    "templates:update",
    "templates:delete",
    "templates:test",
    "templates:analytics",
    "templates:sync",
    "quick_replies:read",
    "quick_replies:create",
    "quick_replies:manage_team",
    "quick_replies:manage_workspace",
    "quick_replies:analytics",
    "quick_replies:import_export",
    "reports:read",
    "attachments:read",
    "attachments:download",
    "attachments:delete",
    "attachments:retry",
    "files:view",
    "files:upload",
    "files:download",
    "files:send",
    "files:rename",
    "files:move",
    "files:share",
    "files:archive",
    "files:delete",
    "files:restore",
    "files:manage_connections",
    "files:view_audit",
    "search:use",
    "search:notes",
    "search:bitrix",
    "automations:read",
    "automations:create",
    "automations:update",
    "automations:publish",
    "automations:pause",
    "automations:runs:read",
    "open_channels:read",
    "open_channels:manage",
    "open_channels:test",
    "retention:read",
    "retention:manage",
    "operations:metrics:read",
    "operations:health:read",
    "privacy:read",
    "privacy:manage",
    "usage:read",
    "ai:read",
    "ai:manage",
    "ai:copilot",
    "ai:approve",
    "ai:training",
  ]),
  team_lead: new Set([
    "inbox:read",
    "message:send",
    "conversation:assign",
    "conversation:operate",
    "conversation:bulk",
    "conversation:notes",
    "conversation:export",
    "labels:read",
    "labels:assign",
    "labels:create_team",
    "labels:update",
    "labels:archive",
    "labels:merge",
    "labels:bulk",
    "labels:analytics",
    "labels:manage",
    "views:manage",
    "crm:write",
    "templates:read",
    "templates:create",
    "templates:update",
    "templates:test",
    "templates:analytics",
    "quick_replies:read",
    "quick_replies:create",
    "quick_replies:manage_team",
    "quick_replies:analytics",
    "quick_replies:import_export",
    "reports:read",
    "attachments:read",
    "attachments:download",
    "attachments:retry",
    "files:view",
    "files:upload",
    "files:download",
    "files:send",
    "files:rename",
    "files:move",
    "files:archive",
    "files:restore",
    "files:view_audit",
    "search:use",
    "search:notes",
    "search:bitrix",
    "automations:read",
    "automations:create",
    "automations:update",
    "automations:runs:read",
    "open_channels:read",
    "retention:read",
    "operations:health:read",
    "ai:read",
    "ai:copilot",
    "ai:approve",
    "ai:training",
  ]),
  agent: new Set([
    "inbox:read",
    "message:send",
    "conversation:operate",
    "conversation:notes",
    "labels:read",
    "labels:assign",
    "views:manage",
    "crm:write",
    "templates:read",
    "quick_replies:read",
    "quick_replies:create",
    "quick_replies:import_export",
    "attachments:read",
    "attachments:download",
    "files:view",
    "files:upload",
    "files:download",
    "files:send",
    "search:use",
    "search:notes",
    "search:bitrix",
    "ai:copilot",
    "ai:approve",
  ]),
  viewer: new Set([
    "inbox:read",
    "labels:read",
    "templates:read",
    "quick_replies:read",
    "files:view",
  ]),
};

export interface AuthClaims {
  sub: string;
  organizationId: string;
  role: Role;
  email: string;
  // Independent of organization membership/role: grants access to the
  // cross-tenant platform-admin panel. Never derive this from `role` --
  // an org owner is not a platform admin.
  platformAdmin?: boolean;
}
export function can(role: Role, permission: Permission): boolean {
  // Roles can arrive from persisted rows or token claims; an unknown value
  // must be a denial, not a thrown TypeError that turns into a 500.
  return grants[role]?.has(permission) ?? false;
}
export function assertOrganization(
  claims: AuthClaims,
  organizationId: string,
): void {
  if (claims.organizationId !== organizationId)
    throw new Error("organization_scope_mismatch");
}

const argon2Options = {
  algorithm: Algorithm.Argon2id,
  version: Version.V0x13,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, argon2Options);
}

export async function verifyPassword(
  passwordHash: string,
  password: string,
): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

export function createOpaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashOpaqueToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export type RefreshReuseAction = "rotate" | "revoke_family" | "reject";

export function refreshReuseAction(session: {
  revokedAt: Date | null;
  replacedById: string | null;
}): RefreshReuseAction {
  if (session.revokedAt) return "reject";
  return session.replacedById ? "revoke_family" : "rotate";
}
