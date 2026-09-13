export const META_WHATSAPP_WEBHOOK_FIELDS = [
  "account_alerts",
  "account_review_update",
  "account_settings_update",
  "account_update",
  "automatic_events",
  "business_capability_update",
  "business_status_update",
  "business_username_updates",
  "calls",
  "flows",
  "group_lifecycle_update",
  "group_participants_update",
  "group_settings_update",
  "group_status_update",
  "history",
  "message_echoes",
  "message_template_components_update",
  "message_template_quality_update",
  "message_template_status_update",
  "messages",
  "messaging_handovers",
  "partner_solutions",
  "payment_configuration_update",
  "phone_number_name_update",
  "phone_number_quality_update",
  "security",
  "smb_app_state_sync",
  "smb_message_echoes",
  "standby",
  "template_category_update",
  "template_correct_category_detection",
  "tracking_events",
  "user_preferences",
] as const;

export type MetaWhatsAppWebhookField =
  (typeof META_WHATSAPP_WEBHOOK_FIELDS)[number];

// Snapshot from the app's Meta v25.0 dashboard on 2026-07-24. Keep this list
// explicit so a dashboard change produces a reviewable test diff.
export const META_WHATSAPP_UNSUBSCRIBED_FIELDS = [
  "message_echoes",
] as const satisfies readonly MetaWhatsAppWebhookField[];

const knownFields = new Set<string>(META_WHATSAPP_WEBHOOK_FIELDS);

export interface MetaWebhookChange {
  entryIndex: number;
  changeIndex: number;
  entryId: string | null;
  field: string;
  knownField: boolean;
  phoneNumberIds: string[];
  change: Record<string, unknown>;
  payload: Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function normalizeMetaWebhookField(value: unknown): string {
  if (typeof value !== "string") return "unknown";
  const normalized = value.trim().toLowerCase();
  return /^[a-z0-9_]+$/.test(normalized) ? normalized : "unknown";
}

export function extractMetaWebhookChanges(
  payload: unknown,
): MetaWebhookChange[] {
  const root = record(payload);
  const entries = Array.isArray(root?.entry) ? root.entry : [];
  const result: MetaWebhookChange[] = [];

  entries.forEach((rawEntry, entryIndex) => {
    const entry = record(rawEntry);
    if (!entry) return;
    const changes = Array.isArray(entry.changes) ? entry.changes : [];
    changes.forEach((rawChange, changeIndex) => {
      const change = record(rawChange);
      if (!change) return;
      const field = normalizeMetaWebhookField(change.field);
      const value = record(change.value);
      const metadata = record(value?.metadata);
      const phoneNumberId = metadata?.phone_number_id;
      result.push({
        entryIndex,
        changeIndex,
        entryId: typeof entry.id === "string" ? entry.id : null,
        field,
        knownField: knownFields.has(field),
        phoneNumberIds:
          typeof phoneNumberId === "string" ? [phoneNumberId] : [],
        change,
        payload: { ...entry, changes: [change] },
      });
    });
  });

  return result;
}

export function metaWebhookEventType(field: string): string {
  return `meta.${normalizeMetaWebhookField(field)}`;
}

export function metaWebhookRealtimeEventType(field: string): string {
  return `whatsapp.webhook.${normalizeMetaWebhookField(field)}`;
}

export function metaWebhookTargetsPhone(
  change: Pick<MetaWebhookChange, "phoneNumberIds">,
  expectedPhoneNumberId: string,
): boolean {
  return (
    change.phoneNumberIds.length === 0 ||
    change.phoneNumberIds.every((id) => id === expectedPhoneNumberId)
  );
}

export function metaWebhookFieldFromEventType(eventType: string): string {
  return eventType.startsWith("meta.")
    ? normalizeMetaWebhookField(eventType.slice(5))
    : "unknown";
}
