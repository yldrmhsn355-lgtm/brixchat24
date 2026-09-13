export function resolveLineQueueResponsibleExternalUserId(
  queueUserIds: string[],
  requestedExternalUserId?: string | null,
) {
  const queue = [
    ...new Set(queueUserIds.map((value) => value.trim()).filter(Boolean)),
  ];
  if (queue.length === 1) return queue[0]!;
  const requested = requestedExternalUserId?.trim();
  return requested && queue.includes(requested) ? requested : null;
}

export function resolveOpenChannelsLeadResponsibleOverride(input: {
  ownership: "bitrix_open_channel" | "direct_crm";
  configuredExternalUserId?: string | null;
}) {
  // A line queue controls who answers an Open Channel conversation; it must
  // never become an implicit CRM owner. Explicit CRM assignment remains
  // available through the dedicated assignment and automation flows.
  void input;
  return null;
}
