export type OpenChannelStatus = "active" | "warning" | "disabled";
export type OpenChannelStatusFilter = "all" | OpenChannelStatus;
export type OpenChannelDirection = "both" | "incoming" | "outgoing" | "none";

export type OpenChannelPresentationItem = {
  id: string;
  connectionName: string;
  channelName: string;
  lineName: string;
  connectorId: string;
  crmLabel: string;
  direction: OpenChannelDirection;
  status: OpenChannelStatus;
};

type OpenChannelStateLike = {
  status?: string;
  open_channels_status?: string;
  last_error?: string | null;
};

export function deriveOpenChannelStatus(
  state: OpenChannelStateLike | null,
): OpenChannelStatus {
  if (!state) return "warning";
  const status = (
    state.status ??
    state.open_channels_status ??
    ""
  ).toLowerCase();
  if (state.last_error || ["warning", "failed", "error"].includes(status))
    return "warning";
  if (status === "active") return "active";
  if (status === "disabled") return "disabled";
  return "warning";
}

export function getOpenChannelDirection(
  incomingEnabled?: boolean,
  outgoingEnabled?: boolean,
): OpenChannelDirection {
  if (incomingEnabled && outgoingEnabled) return "both";
  if (incomingEnabled) return "incoming";
  if (outgoingEnabled) return "outgoing";
  return "none";
}

export function getDirectionLabel(direction: OpenChannelDirection) {
  return {
    both: "Çift yönlü",
    incoming: "Gelen mesajlar",
    outgoing: "Giden mesajlar",
    none: "Akış kapalı",
  }[direction];
}

export function getCrmRuleLabel(
  mode?: "disabled" | "lead" | "contact_and_deal",
) {
  return {
    disabled: "Otomatik kayıt yok",
    lead: "Numara yoksa Lead oluştur",
    contact_and_deal: "Numara yoksa Kişi + Fırsat oluştur",
  }[mode ?? "disabled"];
}

export function filterOpenChannelItems<T extends OpenChannelPresentationItem>(
  items: T[],
  search: string,
  status: OpenChannelStatusFilter,
) {
  const term = search.trim().toLocaleLowerCase("tr-TR");
  return items.filter((item) => {
    if (status !== "all" && item.status !== status) return false;
    if (!term) return true;
    return [
      item.connectionName,
      item.channelName,
      item.lineName,
      item.connectorId,
      item.crmLabel,
      getDirectionLabel(item.direction),
    ].some((value) => value.toLocaleLowerCase("tr-TR").includes(term));
  });
}

export function getStatusCounts(items: OpenChannelPresentationItem[]) {
  return {
    all: items.length,
    active: items.filter((item) => item.status === "active").length,
    warning: items.filter((item) => item.status === "warning").length,
    disabled: items.filter((item) => item.status === "disabled").length,
  };
}
