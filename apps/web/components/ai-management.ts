export type AiAgentStatus = "draft" | "active" | "paused" | "archived";

export type AiAgentSummary = {
  id: string;
  name: string;
  description: string | null;
  status: AiAgentStatus;
  published_version: number | null;
  published_mode: string | null;
  published_model: string | null;
  draft_version: number | null;
  channel_count: number | string | null;
  runs_today: number | string | null;
  cost_today: number | string | null;
  created_at: string;
  updated_at: string;
};

export type AiAgentStatusFilter = "all" | AiAgentStatus;

export type AiUsageDay = {
  day: string;
  runs: number | string | null;
  auto_sent: number | string | null;
  drafts: number | string | null;
  suggested: number | string | null;
  handoffs: number | string | null;
  failures: number | string | null;
  input_tokens: number | string | null;
  output_tokens: number | string | null;
  total_cost_usd: number | string | null;
};

export const AI_TOOL_DEFINITIONS: ReadonlyArray<{
  name: string;
  label: string;
  description: string;
}> = [
  {
    name: "search_knowledge",
    label: "Bilgi tabanında arama",
    description: "Bağlı bilgi tabanlarındaki belgelerde arama yapar.",
  },
  {
    name: "get_contact",
    label: "Kişi bilgisi",
    description: "Müşteri kartındaki temel bilgileri okur.",
  },
  {
    name: "get_conversation_context",
    label: "Konuşma bağlamı",
    description: "Konuşma geçmişini ve etiketleri okur.",
  },
  {
    name: "get_business_hours",
    label: "Çalışma saatleri",
    description: "İşletmenin çalışma saatlerini sorgular.",
  },
  {
    name: "list_approved_templates",
    label: "Onaylı şablonlar",
    description: "Onaylanmış mesaj şablonlarını listeler.",
  },
  {
    name: "add_label",
    label: "Etiket ekleme",
    description: "Konuşmaya etiket ekler.",
  },
  {
    name: "create_internal_note",
    label: "İç not oluşturma",
    description: "Ekibe görünen dahili not bırakır.",
  },
  {
    name: "remember_customer_fact",
    label: "Müşteri bilgisi hatırlama",
    description: "Müşteriyle ilgili kalıcı bir bilgi kaydeder.",
  },
];

const AGENT_STATUS_LABELS: Record<string, string> = {
  draft: "Taslak",
  active: "Aktif",
  paused: "Duraklatıldı",
  archived: "Arşivlendi",
};

const MODE_LABELS: Record<string, string> = {
  observe: "Gözlem",
  copilot: "Yardımcı pilot",
  approval: "Onay ile gönder",
  autopilot: "Otomatik pilot",
};

const DECISION_LABELS: Record<string, string> = {
  auto_sent: "Otomatik gönderildi",
  draft_created: "Taslak oluşturuldu",
  suggested: "Önerildi",
  handoff: "İnsana devir",
  blocked: "Engellendi",
  observed: "Gözlem",
  skipped: "Atlandı",
};

const DOCUMENT_STATUS_LABELS: Record<string, string> = {
  pending: "Bekliyor",
  indexing: "İndeksleniyor",
  ready: "Hazır",
  failed: "Hata",
};

const TRAINING_STATUS_LABELS: Record<string, string> = {
  pending: "Bekliyor",
  approved: "Onaylandı",
  rejected: "Reddedildi",
};

const TOOL_PERMISSION_LABELS: Record<string, string> = {
  allowed: "İzinli",
  approval: "Onay gerekli",
  denied: "Engelli",
};

export function agentStatusLabel(status: string | null | undefined): string {
  if (!status) return "—";
  return AGENT_STATUS_LABELS[status] ?? status;
}

export function agentModeLabel(mode: string | null | undefined): string {
  if (!mode) return "—";
  return MODE_LABELS[mode] ?? mode;
}

export function decisionLabel(decision: string | null | undefined): string {
  if (!decision) return "—";
  return DECISION_LABELS[decision] ?? decision;
}

export function decisionBadgeClass(
  decision: string | null | undefined,
): string {
  switch (decision) {
    case "auto_sent":
      return "positive";
    case "draft_created":
    case "suggested":
      return "info";
    case "handoff":
      return "warning";
    case "blocked":
      return "danger";
    default:
      return "neutral";
  }
}

export function documentStatusLabel(status: string | null | undefined): string {
  if (!status) return "—";
  return DOCUMENT_STATUS_LABELS[status] ?? status;
}

export function documentStatusClass(status: string | null | undefined): string {
  if (status === "ready") return "positive";
  if (status === "failed") return "danger";
  if (status === "indexing") return "info";
  return "neutral";
}

export function trainingStatusLabel(status: string | null | undefined): string {
  if (!status) return "—";
  return TRAINING_STATUS_LABELS[status] ?? status;
}

export function toolPermissionLabel(value: string | null | undefined): string {
  if (!value) return TOOL_PERMISSION_LABELS.allowed!;
  return TOOL_PERMISSION_LABELS[value] ?? value;
}

export function toNumber(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (value == null || value === "") return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function formatUsd(value: unknown): string {
  const amount = toNumber(value);
  const digits = amount !== 0 && Math.abs(amount) < 0.01 ? 4 : 2;
  return `$${amount.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: digits,
  })}`;
}

export function formatCount(value: unknown): string {
  return toNumber(value).toLocaleString("tr-TR");
}

export function formatLatency(value: unknown): string {
  const ms = toNumber(value);
  if (ms <= 0) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toLocaleString("tr-TR", { maximumFractionDigits: 1 })} sn`;
}

export function formatPercent(value: number): string {
  return `%${value.toLocaleString("tr-TR", { maximumFractionDigits: 1 })}`;
}

export function formatAiDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("tr-TR", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function parseMaybeJson<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === "string") {
    if (!value.trim()) return fallback;
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

export function splitCommaList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function filterAiAgents(
  agents: AiAgentSummary[],
  query: string,
  status: AiAgentStatusFilter,
): AiAgentSummary[] {
  const normalizedQuery = query.trim().toLocaleLowerCase("tr-TR");
  return agents
    .filter((agent) =>
      status === "archived"
        ? agent.status === "archived"
        : agent.status !== "archived",
    )
    .filter(
      (agent) =>
        status === "all" || status === "archived" || agent.status === status,
    )
    .filter((agent) => {
      if (!normalizedQuery) return true;
      return `${agent.name} ${agent.description ?? ""}`
        .toLocaleLowerCase("tr-TR")
        .includes(normalizedQuery);
    })
    .sort(
      (left, right) =>
        new Date(right.updated_at).getTime() -
        new Date(left.updated_at).getTime(),
    );
}

export function summarizeAiAgents(agents: AiAgentSummary[]) {
  const visible = agents.filter((agent) => agent.status !== "archived");
  return {
    total: visible.length,
    active: visible.filter((agent) => agent.status === "active").length,
    runsToday: visible.reduce(
      (sum, agent) => sum + toNumber(agent.runs_today),
      0,
    ),
    costToday: visible.reduce(
      (sum, agent) => sum + toNumber(agent.cost_today),
      0,
    ),
  };
}

export function summarizeAiUsage(daily: AiUsageDay[]) {
  const runs = daily.reduce((sum, day) => sum + toNumber(day.runs), 0);
  const autoSent = daily.reduce((sum, day) => sum + toNumber(day.auto_sent), 0);
  const handoffs = daily.reduce((sum, day) => sum + toNumber(day.handoffs), 0);
  const failures = daily.reduce((sum, day) => sum + toNumber(day.failures), 0);
  const cost = daily.reduce(
    (sum, day) => sum + toNumber(day.total_cost_usd),
    0,
  );
  return {
    runs,
    autoSent,
    handoffs,
    failures,
    cost,
    autoRate: runs > 0 ? (autoSent / runs) * 100 : 0,
    handoffRate: runs > 0 ? (handoffs / runs) * 100 : 0,
  };
}
