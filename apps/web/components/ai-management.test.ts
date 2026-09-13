import { describe, expect, it } from "vitest";
import {
  decisionBadgeClass,
  decisionLabel,
  documentStatusLabel,
  filterAiAgents,
  formatLatency,
  formatUsd,
  parseMaybeJson,
  splitCommaList,
  summarizeAiAgents,
  summarizeAiUsage,
  type AiAgentSummary,
} from "./ai-management";

function agent(overrides: Partial<AiAgentSummary>): AiAgentSummary {
  return {
    id: "a1",
    name: "Destek Ajanı",
    description: null,
    status: "active",
    published_version: 1,
    published_mode: "copilot",
    published_model: "openai/gpt-4o-mini",
    draft_version: null,
    channel_count: 0,
    runs_today: 0,
    cost_today: 0,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("decisionLabel", () => {
  it("maps known decisions to Turkish labels", () => {
    expect(decisionLabel("auto_sent")).toBe("Otomatik gönderildi");
    expect(decisionLabel("handoff")).toBe("İnsana devir");
    expect(decisionLabel("blocked")).toBe("Engellendi");
    expect(decisionLabel("observed")).toBe("Gözlem");
  });

  it("falls back for unknown or missing values", () => {
    expect(decisionLabel("mystery")).toBe("mystery");
    expect(decisionLabel(null)).toBe("—");
  });

  it("assigns badge classes by decision severity", () => {
    expect(decisionBadgeClass("auto_sent")).toBe("positive");
    expect(decisionBadgeClass("suggested")).toBe("info");
    expect(decisionBadgeClass("handoff")).toBe("warning");
    expect(decisionBadgeClass("blocked")).toBe("danger");
    expect(decisionBadgeClass("skipped")).toBe("neutral");
  });
});

describe("documentStatusLabel", () => {
  it("maps indexing states", () => {
    expect(documentStatusLabel("pending")).toBe("Bekliyor");
    expect(documentStatusLabel("indexing")).toBe("İndeksleniyor");
    expect(documentStatusLabel("ready")).toBe("Hazır");
    expect(documentStatusLabel("failed")).toBe("Hata");
  });
});

describe("filterAiAgents", () => {
  const agents = [
    agent({ id: "a1", name: "Satış Botu", status: "active" }),
    agent({
      id: "a2",
      name: "Destek Botu",
      status: "draft",
      description: "İade süreçleri",
    }),
    agent({ id: "a3", name: "Eski Bot", status: "archived" }),
  ];

  it("hides archived agents by default", () => {
    const visible = filterAiAgents(agents, "", "all");
    expect(visible.map((item) => item.id).sort()).toEqual(["a1", "a2"]);
  });

  it("filters by status", () => {
    expect(filterAiAgents(agents, "", "draft").map((item) => item.id)).toEqual([
      "a2",
    ]);
  });

  it("matches Turkish-case-insensitive search on name and description", () => {
    expect(filterAiAgents(agents, "İADE", "all").map((item) => item.id)).toEqual(
      ["a2"],
    );
  });

  it("shows only archived agents for the archived filter", () => {
    expect(
      filterAiAgents(agents, "", "archived").map((item) => item.id),
    ).toEqual(["a3"]);
  });
});

describe("summarizeAiAgents", () => {
  it("sums usage while ignoring archived agents and coercing strings", () => {
    const summary = summarizeAiAgents([
      agent({ id: "a1", status: "active", runs_today: "12", cost_today: "0.5" }),
      agent({ id: "a2", status: "paused", runs_today: 3, cost_today: 0.25 }),
      agent({ id: "a3", status: "archived", runs_today: 99, cost_today: 9 }),
    ]);
    expect(summary.total).toBe(2);
    expect(summary.active).toBe(1);
    expect(summary.runsToday).toBe(15);
    expect(summary.costToday).toBeCloseTo(0.75);
  });
});

describe("summarizeAiUsage", () => {
  it("computes totals and rates from daily rows", () => {
    const summary = summarizeAiUsage([
      {
        day: "2026-08-01",
        runs: "10",
        auto_sent: "4",
        drafts: 2,
        suggested: 2,
        handoffs: "1",
        failures: 0,
        input_tokens: 100,
        output_tokens: 50,
        total_cost_usd: "0.10",
      },
      {
        day: "2026-08-02",
        runs: 10,
        auto_sent: 6,
        drafts: 0,
        suggested: 2,
        handoffs: 1,
        failures: 1,
        input_tokens: 100,
        output_tokens: 50,
        total_cost_usd: 0.2,
      },
    ]);
    expect(summary.runs).toBe(20);
    expect(summary.autoSent).toBe(10);
    expect(summary.autoRate).toBeCloseTo(50);
    expect(summary.handoffRate).toBeCloseTo(10);
    expect(summary.cost).toBeCloseTo(0.3);
  });

  it("avoids division by zero", () => {
    const summary = summarizeAiUsage([]);
    expect(summary.autoRate).toBe(0);
    expect(summary.handoffRate).toBe(0);
  });
});

describe("parseMaybeJson", () => {
  it("parses JSON strings and passes through parsed values", () => {
    expect(parseMaybeJson<string[]>('["a","b"]', [])).toEqual(["a", "b"]);
    expect(parseMaybeJson<string[]>(["x"], [])).toEqual(["x"]);
  });

  it("returns the fallback for null or invalid JSON", () => {
    expect(parseMaybeJson<string[]>(null, ["f"])).toEqual(["f"]);
    expect(parseMaybeJson<string[]>("{oops", ["f"])).toEqual(["f"]);
  });
});

describe("formatting", () => {
  it("formats USD with extra precision for sub-cent amounts", () => {
    expect(formatUsd(0.0034)).toBe("$0.0034");
    expect(formatUsd("1.5")).toBe("$1.50");
    expect(formatUsd(null)).toBe("$0.00");
  });

  it("formats latency in ms and seconds", () => {
    expect(formatLatency(480)).toBe("480 ms");
    expect(formatLatency(2400)).toContain("sn");
    expect(formatLatency(0)).toBe("—");
  });

  it("splits comma lists and trims empties", () => {
    expect(splitCommaList(" iade,  kargo ,,fiyat ")).toEqual([
      "iade",
      "kargo",
      "fiyat",
    ]);
  });
});
