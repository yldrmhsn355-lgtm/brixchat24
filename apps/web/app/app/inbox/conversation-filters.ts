export type ConversationAssignmentFilter =
  "all" | "assigned_to_me" | "unassigned";

export type ConversationStatusFilter =
  "all" | "open" | "waiting" | "snoozed" | "closed" | "archived";

export type ConversationToolbarFilters = {
  assignment: ConversationAssignmentFilter;
  unreadOnly: boolean;
  status: ConversationStatusFilter;
  labelIds: string[];
  labelOperator: "any" | "all" | "not";
  unlabeled: boolean;
};

export const DEFAULT_CONVERSATION_FILTERS: ConversationToolbarFilters = {
  assignment: "all",
  unreadOnly: false,
  status: "all",
  labelIds: [],
  labelOperator: "any",
  unlabeled: false,
};

const assignments = new Set<ConversationAssignmentFilter>([
  "all",
  "assigned_to_me",
  "unassigned",
]);

const statuses = new Set<ConversationStatusFilter>([
  "all",
  "open",
  "waiting",
  "snoozed",
  "closed",
  "archived",
]);

export function readConversationFilters(
  search: string,
): ConversationToolbarFilters {
  const params = new URLSearchParams(search);
  const assignment = params.get("assignment") as ConversationAssignmentFilter;
  const status = params.get("status") as ConversationStatusFilter;
  const labelIds = (params.get("labels") ?? params.get("label") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, 20);
  const labelOperator = params.get("labelOp");

  return {
    assignment: assignments.has(assignment) ? assignment : "all",
    unreadOnly: params.get("unread") === "1",
    status: statuses.has(status) ? status : "all",
    labelIds,
    labelOperator:
      labelOperator === "all" || labelOperator === "not"
        ? labelOperator
        : "any",
    unlabeled: params.get("unlabeled") === "1",
  };
}

export function writeConversationFilters(
  params: URLSearchParams,
  filters: ConversationToolbarFilters,
) {
  if (filters.assignment === "all") params.delete("assignment");
  else params.set("assignment", filters.assignment);

  if (filters.unreadOnly) params.set("unread", "1");
  else params.delete("unread");

  if (filters.status === "all") params.delete("status");
  else params.set("status", filters.status);

  params.delete("label");
  if (filters.labelIds.length > 0) {
    params.set("labels", filters.labelIds.join(","));
    if (filters.labelOperator === "any") params.delete("labelOp");
    else params.set("labelOp", filters.labelOperator);
  } else {
    params.delete("labels");
    params.delete("labelOp");
  }
  if (filters.unlabeled) params.set("unlabeled", "1");
  else params.delete("unlabeled");
}

export function activeConversationFilterCount(
  filters: ConversationToolbarFilters,
  channelId: string,
) {
  return (
    Number(filters.assignment !== "all") +
    Number(filters.unreadOnly) +
    Number(filters.status !== "all") +
    Number(filters.labelIds.length > 0) +
    Number(filters.unlabeled) +
    Number(channelId !== "all")
  );
}

export function buildConversationQuery(input: {
  query: string;
  cursor: string | null;
  append: boolean;
  channelId: string;
  sidebarScope: string;
  filters: ConversationToolbarFilters;
}) {
  const params = new URLSearchParams({
    limit: "50",
    search: input.query,
  });

  if (input.cursor && input.append) params.set("cursor", input.cursor);
  if (input.channelId !== "all") params.set("channelId", input.channelId);

  const assignment =
    input.filters.assignment !== "all"
      ? input.filters.assignment
      : input.sidebarScope === "assigned_to_me" ||
          input.sidebarScope === "unassigned"
        ? input.sidebarScope
        : null;
  if (assignment) params.set("scope", assignment);

  if (input.filters.unreadOnly || input.sidebarScope === "unread")
    params.set("unreadOnly", "true");

  const status =
    input.filters.status !== "all"
      ? input.filters.status
      : statuses.has(input.sidebarScope as ConversationStatusFilter) &&
          input.sidebarScope !== "all"
        ? (input.sidebarScope as ConversationStatusFilter)
        : null;
  if (status) params.set("status", status);
  if (status !== "archived") params.set("excludeArchived", "true");

  const sidebarLabelId = input.sidebarScope.startsWith("label:")
    ? input.sidebarScope.slice(6)
    : null;
  const labelIds =
    input.filters.labelIds.length > 0
      ? input.filters.labelIds
      : sidebarLabelId
        ? [sidebarLabelId]
        : [];
  if (labelIds.length > 0) {
    const key =
      input.filters.labelOperator === "all"
        ? "labelIdsAll"
        : input.filters.labelOperator === "not"
          ? "labelIdsNot"
          : "labelIdsAny";
    params.set(key, labelIds.join(","));
  }
  if (input.filters.unlabeled) params.set("unlabeled", "true");

  return params.toString();
}
