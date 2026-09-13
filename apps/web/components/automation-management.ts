export type AutomationRuleSummary = {
  id: string;
  name: string;
  description?: string | null;
  status: string;
  priority?: number;
  draft_version?: number;
  published_version?: number | null;
  updated_at: string;
  last_run_at?: string | null;
};

export type AutomationStatusFilter = "all" | "active" | "draft" | "paused";

export function filterAutomationRules(
  rules: AutomationRuleSummary[],
  query: string,
  status: AutomationStatusFilter,
) {
  const normalizedQuery = query.trim().toLocaleLowerCase("tr-TR");
  return rules
    .filter((rule) => rule.status !== "archived")
    .filter((rule) => status === "all" || rule.status === status)
    .filter((rule) => {
      if (!normalizedQuery) return true;
      return `${rule.name} ${rule.description ?? ""}`
        .toLocaleLowerCase("tr-TR")
        .includes(normalizedQuery);
    })
    .sort(
      (left, right) =>
        new Date(right.updated_at).getTime() -
        new Date(left.updated_at).getTime(),
    );
}

export function summarizeAutomationRules(rules: AutomationRuleSummary[]) {
  const visible = rules.filter((rule) => rule.status !== "archived");
  return {
    total: visible.length,
    active: visible.filter((rule) => rule.status === "active").length,
    draft: visible.filter((rule) => rule.status === "draft").length,
    paused: visible.filter((rule) => rule.status === "paused").length,
  };
}
