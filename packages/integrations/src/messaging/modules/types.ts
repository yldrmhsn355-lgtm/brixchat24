import type { MessagingProvider } from "../types";

export type MessagingProviderModuleInput = {
  fakeMode?:
    | "success"
    | "temporary_error"
    | "permanent_error"
    | "auth_failure"
    | "token_expired"
    | "permission_denied";
  apiVersion?: string;
  timeoutMs?: number;
};

export type MessagingProviderModule = {
  moduleId: string;
  provider: string;
  platform: string;
  adapterKind: "messaging" | "worker_runtime" | "none";
  crm: {
    inbound: "canonical_message";
    outbound: "canonical_outbox";
    timeline: "crm_sync_job";
  };
  create?: (input: MessagingProviderModuleInput) => MessagingProvider;
};
