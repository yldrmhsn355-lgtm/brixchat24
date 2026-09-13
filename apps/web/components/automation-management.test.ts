import { describe, expect, it } from "vitest";
import {
  filterAutomationRules,
  summarizeAutomationRules,
  type AutomationRuleSummary,
} from "./automation-management";

const rules: AutomationRuleSummary[] = [
  {
    id: "1",
    name: "Yeni müşteri karşılama",
    description: "İlk mesaja cevap verir",
    status: "active",
    updated_at: "2026-07-30T08:00:00.000Z",
  },
  {
    id: "2",
    name: "Gece yönlendirmesi",
    description: null,
    status: "draft",
    updated_at: "2026-07-29T08:00:00.000Z",
  },
  {
    id: "3",
    name: "Eski akış",
    description: "Arşivlenmiş kayıt",
    status: "archived",
    updated_at: "2026-07-28T08:00:00.000Z",
  },
];

describe("automation management helpers", () => {
  it("filters by query and status while excluding archived rules", () => {
    expect(filterAutomationRules(rules, "gece", "all").map((rule) => rule.id)).toEqual([
      "2",
    ]);
    expect(filterAutomationRules(rules, "", "active").map((rule) => rule.id)).toEqual([
      "1",
    ]);
    expect(filterAutomationRules(rules, "", "all").map((rule) => rule.id)).toEqual([
      "1",
      "2",
    ]);
  });

  it("summarizes active, draft, and paused rules", () => {
    expect(summarizeAutomationRules(rules)).toEqual({
      total: 2,
      active: 1,
      draft: 1,
      paused: 0,
    });
  });
});
