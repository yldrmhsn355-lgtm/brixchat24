"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Archive,
  ArrowLeft,
  History,
  PauseCircle,
  Play,
  Plus,
  RefreshCw,
  Rocket,
  Trash2,
  X,
} from "lucide-react";
import { AppFrame } from "./app-frame";
import { AiNav } from "./ai-nav";
import { AiModelInput } from "./ai-model-picker";
import { apiJson } from "../lib/api";
import {
  AI_TOOL_DEFINITIONS,
  agentModeLabel,
  agentStatusLabel,
  formatAiDate,
  parseMaybeJson,
  splitCommaList,
  toNumber,
} from "./ai-management";

type VersionRow = {
  id?: string;
  version: number;
  status: string;
  mode: string;
  model: string | null;
  fallback_model: string | null;
  temperature: number | string | null;
  max_steps: number | string | null;
  max_cost_per_run_usd: number | string | null;
  default_language: string | null;
  allowed_languages: unknown;
  system_instruction: string | null;
  business_objective: string | null;
  persona: unknown;
  behavior_rules: unknown;
  forbidden_topics: unknown;
  example_responses: unknown;
  handoff_rules: unknown;
  confidence_threshold: number | string | null;
  working_hours: unknown;
  response_delay_min_ms: number | string | null;
  response_delay_max_ms: number | string | null;
  tool_permissions: unknown;
  config: unknown;
};

type Assignment = {
  id: string;
  channel_id: string;
  channel_name: string;
  provider: string;
  platform: string;
  phone_number: string | null;
  enabled: boolean;
  mode_override: string | null;
};

type AgentDetailData = {
  agent: {
    id: string;
    name: string;
    description: string | null;
    status: string;
  };
  draft: VersionRow | null;
  published: VersionRow | null;
  assignments: Assignment[];
  knowledge: Array<{ knowledge_base_id: string; name: string }>;
};

type ChannelOption = {
  id: string;
  name: string;
  provider?: string;
  platform?: string;
  phoneNumber?: string | null;
};

type KnowledgeBaseOption = {
  id: string;
  name: string;
  status?: string;
  document_count?: number | string | null;
};

type VersionListRow = {
  id: string;
  version: number;
  status: string;
  mode: string;
  model: string | null;
  published_at: string | null;
  retired_at: string | null;
  created_at: string;
};

type PersonaForm = {
  tone: string;
  personality: string;
  communicationStyle: string;
  responseLength: string;
  emojiPolicy: string;
};

type ChannelSelection = { enabled: boolean; modeOverride: string };

type AgentForm = {
  name: string;
  description: string;
  mode: string;
  defaultLanguage: string;
  allowedLanguages: string;
  businessObjective: string;
  systemInstruction: string;
  behaviorRules: string[];
  forbiddenTopics: string[];
  persona: PersonaForm;
  exampleResponses: Array<{ customer: string; reply: string }>;
  toolPermissions: Record<string, string>;
  confidenceThreshold: string;
  handoffOnHumanRequest: boolean;
  handoffOnNegativeSentiment: boolean;
  handoffOnMissingKnowledge: boolean;
  restrictedIntents: string[];
  maxConsecutiveAiMessages: string;
  responseDelayMinMs: string;
  responseDelayMaxMs: string;
  workingHoursTimezone: string;
  workingHoursDays: Record<
    string,
    { enabled: boolean; start: string; end: string }
  >;
  model: string;
  fallbackModel: string;
  temperature: string;
  maxSteps: string;
  maxCostPerRunUsd: string;
  maxOutputTokens: string;
  visionEnabled: boolean;
  webSearchEnabled: boolean;
};

const TABS = [
  { key: "general", label: "Genel" },
  { key: "instructions", label: "Talimatlar" },
  { key: "examples", label: "Örnekler" },
  { key: "knowledge", label: "Bilgi" },
  { key: "tools", label: "Araçlar" },
  { key: "channels", label: "Kanallar" },
  { key: "safety", label: "Güvenlik" },
  { key: "model", label: "Model" },
  { key: "versions", label: "Sürümler" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

const WEEKDAYS: ReadonlyArray<{ key: string; label: string }> = [
  { key: "1", label: "Pazartesi" },
  { key: "2", label: "Salı" },
  { key: "3", label: "Çarşamba" },
  { key: "4", label: "Perşembe" },
  { key: "5", label: "Cuma" },
  { key: "6", label: "Cumartesi" },
  { key: "7", label: "Pazar" },
];

const MODE_OPTIONS = [
  { value: "observe", label: "Gözlem — yanıt üretir ama göndermez" },
  { value: "copilot", label: "Yardımcı pilot — temsilciye taslak sunar" },
  { value: "approval", label: "Onay ile gönder — onaydan sonra iletilir" },
  { value: "autopilot", label: "Otomatik pilot — doğrudan gönderir" },
];

function withCurrent(
  value: string,
  options: Array<{ value: string; label: string }>,
) {
  if (!value || options.some((option) => option.value === value))
    return options;
  return [{ value, label: value }, ...options];
}

function buildForm(
  agent: AgentDetailData["agent"],
  version: VersionRow | null,
): AgentForm {
  const persona = parseMaybeJson<Partial<PersonaForm>>(version?.persona, {});
  const handoff = parseMaybeJson<{
    onHumanRequest?: boolean;
    onNegativeSentiment?: boolean;
    onMissingKnowledge?: boolean;
    restrictedIntents?: string[];
    maxConsecutiveAiMessages?: number;
  }>(version?.handoff_rules, {});
  const config = parseMaybeJson<{
    maxOutputTokens?: number;
    visionEnabled?: boolean;
    webSearchEnabled?: boolean;
  }>(version?.config, {});
  const toolPermissions = parseMaybeJson<Record<string, string>>(
    version?.tool_permissions,
    {},
  );
  const workingHours = parseMaybeJson<{
    timezone?: string;
    schedule?: Record<string, Array<{ start: string; end: string }>>;
  }>(version?.working_hours, {});
  return {
    name: agent.name,
    description: agent.description ?? "",
    mode: version?.mode ?? "observe",
    defaultLanguage: version?.default_language ?? "tr",
    allowedLanguages: parseMaybeJson<string[]>(
      version?.allowed_languages,
      [],
    ).join(", "),
    businessObjective: version?.business_objective ?? "",
    systemInstruction: version?.system_instruction ?? "",
    behaviorRules: parseMaybeJson<string[]>(version?.behavior_rules, []),
    forbiddenTopics: parseMaybeJson<string[]>(version?.forbidden_topics, []),
    persona: {
      tone: persona.tone ?? "professional",
      personality: persona.personality ?? "helpful",
      communicationStyle: persona.communicationStyle ?? "clear",
      responseLength: persona.responseLength ?? "medium",
      emojiPolicy: persona.emojiPolicy ?? "sparing",
    },
    exampleResponses: parseMaybeJson<Array<{ customer: string; reply: string }>>(
      version?.example_responses,
      [],
    ),
    toolPermissions,
    confidenceThreshold:
      version?.confidence_threshold != null
        ? String(version.confidence_threshold)
        : "0.7",
    handoffOnHumanRequest: handoff.onHumanRequest ?? true,
    handoffOnNegativeSentiment: handoff.onNegativeSentiment ?? true,
    handoffOnMissingKnowledge: handoff.onMissingKnowledge ?? true,
    restrictedIntents: handoff.restrictedIntents ?? [],
    maxConsecutiveAiMessages: String(handoff.maxConsecutiveAiMessages ?? 6),
    responseDelayMinMs: String(version?.response_delay_min_ms ?? 0),
    responseDelayMaxMs: String(version?.response_delay_max_ms ?? 0),
    workingHoursTimezone: workingHours.timezone ?? "Europe/Istanbul",
    workingHoursDays: Object.fromEntries(
      WEEKDAYS.map((day) => {
        const windows = workingHours.schedule?.[day.key] ?? [];
        const first = windows[0];
        return [
          day.key,
          {
            enabled: windows.length > 0,
            start: first?.start ?? "09:00",
            end: first?.end ?? "18:00",
          },
        ];
      }),
    ),
    model: version?.model ?? "",
    fallbackModel: version?.fallback_model ?? "",
    temperature:
      version?.temperature != null ? String(version.temperature) : "0.3",
    maxSteps: String(version?.max_steps ?? 6),
    maxCostPerRunUsd:
      version?.max_cost_per_run_usd != null
        ? String(version.max_cost_per_run_usd)
        : "0.25",
    maxOutputTokens:
      config.maxOutputTokens != null ? String(config.maxOutputTokens) : "",
    visionEnabled: config.visionEnabled ?? false,
    webSearchEnabled: config.webSearchEnabled ?? false,
  };
}

export function AiAgentDetail({ agentId }: { agentId: string }) {
  const [data, setData] = useState<AgentDetailData | null>(null);
  const [form, setForm] = useState<AgentForm | null>(null);
  const [channels, setChannels] = useState<ChannelOption[]>([]);
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBaseOption[]>(
    [],
  );
  const [selectedKnowledge, setSelectedKnowledge] = useState<string[]>([]);
  const [channelSelection, setChannelSelection] = useState<
    Record<string, ChannelSelection>
  >({});
  const [versions, setVersions] = useState<VersionListRow[]>([]);
  const [tab, setTab] = useState<TabKey>("general");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [statusBusy, setStatusBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmArchive, setConfirmArchive] = useState(false);

  const loadMeta = useCallback(async () => {
    const result = await apiJson<{ data: AgentDetailData }>(
      `/api/v1/ai/agents/${agentId}`,
    );
    setData(result.data);
    return result.data;
  }, [agentId]);

  const loadVersions = useCallback(async () => {
    try {
      const result = await apiJson<{ data: VersionListRow[] }>(
        `/api/v1/ai/agents/${agentId}/versions`,
      );
      setVersions(result.data ?? []);
    } catch {
      setVersions([]);
    }
  }, [agentId]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [detail] = await Promise.all([
        loadMeta(),
        loadVersions(),
        apiJson<{ data: ChannelOption[] }>("/api/v1/channels")
          .then((result) => setChannels(result.data ?? []))
          .catch(() => setChannels([])),
        apiJson<{ data: KnowledgeBaseOption[] }>("/api/v1/ai/knowledge")
          .then((result) => setKnowledgeBases(result.data ?? []))
          .catch(() => setKnowledgeBases([])),
      ]);
      setForm(buildForm(detail.agent, detail.draft ?? detail.published));
      setSelectedKnowledge(
        detail.knowledge.map((item) => item.knowledge_base_id),
      );
      setChannelSelection(
        Object.fromEntries(
          detail.assignments.map((assignment) => [
            assignment.channel_id,
            {
              enabled: assignment.enabled,
              modeOverride: assignment.mode_override ?? "",
            },
          ]),
        ),
      );
      setError("");
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Ajan bilgileri yüklenemedi.",
      );
    } finally {
      setLoading(false);
    }
  }, [loadMeta, loadVersions]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadAll(), 0);
    return () => window.clearTimeout(timer);
  }, [loadAll]);

  function update(partial: Partial<AgentForm>) {
    setForm((current) => (current ? { ...current, ...partial } : current));
  }

  async function patch(payload: Record<string, unknown>) {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      await apiJson<{ data: { draft: VersionRow } }>(
        `/api/v1/ai/agents/${agentId}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      setNotice(
        "Taslak kaydedildi — yayınlamak için Sürümler sekmesini kullanın.",
      );
      await Promise.all([loadMeta(), loadVersions()]);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Değişiklikler kaydedilemedi.",
      );
    } finally {
      setSaving(false);
    }
  }

  async function saveGeneral() {
    if (!form) return;
    await patch({
      name: form.name,
      description: form.description || null,
      mode: form.mode,
      defaultLanguage: form.defaultLanguage,
      allowedLanguages: splitCommaList(form.allowedLanguages),
      businessObjective: form.businessObjective,
    });
  }

  async function saveInstructions() {
    if (!form) return;
    await patch({
      systemInstruction: form.systemInstruction,
      behaviorRules: form.behaviorRules,
      forbiddenTopics: form.forbiddenTopics,
      persona: form.persona,
    });
  }

  async function saveExamples() {
    if (!form) return;
    await patch({
      exampleResponses: form.exampleResponses.filter(
        (example) => example.customer.trim() && example.reply.trim(),
      ),
    });
  }

  async function saveKnowledge() {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      await apiJson(`/api/v1/ai/agents/${agentId}/knowledge`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ knowledgeBaseIds: selectedKnowledge }),
      });
      setNotice("Bilgi tabanı bağlantıları güncellendi.");
      await loadMeta();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Bilgi tabanları kaydedilemedi.",
      );
    } finally {
      setSaving(false);
    }
  }

  async function saveTools() {
    if (!form) return;
    await patch({ toolPermissions: form.toolPermissions });
  }

  async function saveChannels() {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      const assignments = Object.entries(channelSelection)
        .filter(([, selection]) => selection.enabled)
        .map(([channelId, selection]) => ({
          channelId,
          enabled: true,
          ...(selection.modeOverride
            ? { modeOverride: selection.modeOverride }
            : {}),
        }));
      await apiJson(`/api/v1/ai/agents/${agentId}/channels`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ assignments }),
      });
      setNotice("Kanal atamaları güncellendi.");
      await loadMeta();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Kanal atamaları kaydedilemedi.",
      );
    } finally {
      setSaving(false);
    }
  }

  async function saveSafety() {
    if (!form) return;
    await patch({
      confidenceThreshold: toNumber(form.confidenceThreshold),
      handoffRules: {
        onHumanRequest: form.handoffOnHumanRequest,
        onNegativeSentiment: form.handoffOnNegativeSentiment,
        onMissingKnowledge: form.handoffOnMissingKnowledge,
        restrictedIntents: form.restrictedIntents,
        maxConsecutiveAiMessages: Math.max(
          1,
          Math.round(toNumber(form.maxConsecutiveAiMessages)),
        ),
      },
      responseDelayMinMs: Math.max(
        0,
        Math.round(toNumber(form.responseDelayMinMs)),
      ),
      responseDelayMaxMs: Math.max(
        0,
        Math.round(toNumber(form.responseDelayMaxMs)),
      ),
      workingHours: {
        timezone: form.workingHoursTimezone.trim() || "Europe/Istanbul",
        schedule: Object.fromEntries(
          Object.entries(form.workingHoursDays)
            .filter(
              ([, day]) => day.enabled && day.start && day.end && day.start < day.end,
            )
            .map(([key, day]) => [key, [{ start: day.start, end: day.end }]]),
        ),
      },
    });
  }

  function updateWorkingDay(
    key: string,
    partial: Partial<{ enabled: boolean; start: string; end: string }>,
  ) {
    setForm((current) =>
      current
        ? {
            ...current,
            workingHoursDays: {
              ...current.workingHoursDays,
              [key]: { ...current.workingHoursDays[key]!, ...partial },
            },
          }
        : current,
    );
  }

  async function saveModel() {
    if (!form) return;
    await patch({
      model: form.model,
      fallbackModel: form.fallbackModel || null,
      temperature: toNumber(form.temperature),
      maxSteps: Math.max(1, Math.round(toNumber(form.maxSteps))),
      maxCostPerRunUsd: toNumber(form.maxCostPerRunUsd),
      config: {
        ...(form.maxOutputTokens
          ? { maxOutputTokens: Math.round(toNumber(form.maxOutputTokens)) }
          : {}),
        visionEnabled: form.visionEnabled,
        webSearchEnabled: form.webSearchEnabled,
      },
    });
  }

  async function publish() {
    if (publishing) return;
    setPublishing(true);
    setError("");
    try {
      await apiJson(`/api/v1/ai/agents/${agentId}/publish`, {
        method: "POST",
      });
      setNotice("Taslak yayınlandı. Yeni sürüm artık kanallarda kullanılıyor.");
      await Promise.all([loadMeta(), loadVersions()]);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Taslak yayınlanamadı.",
      );
    } finally {
      setPublishing(false);
    }
  }

  async function rollback(version: number) {
    if (publishing) return;
    setPublishing(true);
    setError("");
    try {
      await apiJson(`/api/v1/ai/agents/${agentId}/rollback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version }),
      });
      setNotice(`v${version} sürümüne geri dönüldü.`);
      const detail = await loadMeta();
      setForm(buildForm(detail.agent, detail.draft ?? detail.published));
      await loadVersions();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Sürüme geri dönülemedi.",
      );
    } finally {
      setPublishing(false);
    }
  }

  async function changeStatus(status: "active" | "paused" | "archived") {
    if (statusBusy) return;
    setStatusBusy(true);
    setError("");
    try {
      await apiJson(`/api/v1/ai/agents/${agentId}/status`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status }),
      });
      setNotice(
        status === "active"
          ? "Ajan etkinleştirildi."
          : status === "paused"
            ? "Ajan duraklatıldı."
            : "Ajan arşivlendi.",
      );
      setConfirmArchive(false);
      await loadMeta();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Ajan durumu güncellenemedi.",
      );
    } finally {
      setStatusBusy(false);
    }
  }

  const agentName = data?.agent.name ?? "AI Ajanı";
  const hasDraft = data?.draft != null;

  return (
    <AppFrame
      title={agentName}
      subtitle="Ajan talimatları, bilgi tabanı bağlantıları, kanal atamaları ve sürüm yönetimi."
      actions={
        <div className="inline-actions">
          <Link className="subtle-button" href="/app/ai-chats">
            <ArrowLeft size={15} aria-hidden="true" /> Ajanlara dön
          </Link>
          {hasDraft && (
            <button
              type="button"
              className="primary-button compact-button"
              onClick={() => void publish()}
              disabled={publishing}
            >
              <Rocket size={15} aria-hidden="true" />
              {publishing ? "Yayınlanıyor…" : "Yayınla"}
            </button>
          )}
        </div>
      }
    >
      <AiNav />

      {notice && (
        <div className="success-banner ai-feedback" role="status">
          {notice}
          <button type="button" onClick={() => setNotice("")}>
            Kapat
          </button>
        </div>
      )}
      {error && (
        <div className="error-banner ai-feedback" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => void loadAll()}>
            <RefreshCw size={14} aria-hidden="true" /> Yeniden dene
          </button>
        </div>
      )}

      {loading || !form || !data ? (
        <div className="ai-skeleton-list" aria-label="Yükleniyor">
          <span className="skeleton-block" />
          <span className="skeleton-block" />
          <span className="skeleton-block" />
        </div>
      ) : (
        <>
          <section
            className={`ai-version-banner${hasDraft ? " draft" : ""}`}
            aria-live="polite"
          >
            <div>
              <strong>
                {hasDraft
                  ? `Yayınlanmamış taslak: v${data.draft!.version}`
                  : data.published
                    ? `Yayında: v${data.published.version}`
                    : "Henüz yayınlanmış sürüm yok"}
              </strong>
              <small>
                Durum: {agentStatusLabel(data.agent.status)}
                {data.published
                  ? ` · Yayın modu: ${agentModeLabel(data.published.mode)}`
                  : " · Ajan yayınlanana kadar kanallarda çalışmaz"}
              </small>
            </div>
            {hasDraft && (
              <button
                type="button"
                className="secondary-button"
                onClick={() => void publish()}
                disabled={publishing}
              >
                <Rocket size={15} aria-hidden="true" />
                {publishing ? "Yayınlanıyor…" : "Taslağı yayınla"}
              </button>
            )}
          </section>

          <div
            className="settings-tabs ai-detail-tabs"
            role="tablist"
            aria-label="Ajan yapılandırma sekmeleri"
          >
            {TABS.map((item) => (
              <button
                key={item.key}
                type="button"
                role="tab"
                aria-selected={tab === item.key}
                className={tab === item.key ? "active" : undefined}
                onClick={() => setTab(item.key)}
              >
                {item.label}
              </button>
            ))}
          </div>

          {tab === "general" && (
            <section className="stack-card ai-detail-card">
              <h2>Genel bilgiler</h2>
              <div className="ai-form-grid">
                <label>
                  Ajan adı
                  <input
                    value={form.name}
                    maxLength={120}
                    onChange={(event) => update({ name: event.target.value })}
                  />
                </label>
                <label>
                  Varsayılan dil
                  <input
                    value={form.defaultLanguage}
                    maxLength={10}
                    placeholder="tr"
                    onChange={(event) =>
                      update({ defaultLanguage: event.target.value })
                    }
                  />
                </label>
                <label>
                  İzin verilen diller
                  <input
                    value={form.allowedLanguages}
                    placeholder="tr, en, de"
                    onChange={(event) =>
                      update({ allowedLanguages: event.target.value })
                    }
                  />
                  <small className="ai-note">
                    Boş bırakılırsa tüm diller kabul edilir. Virgülle ayırın.
                  </small>
                </label>
                <label>
                  Çalışma modu
                  <select
                    value={form.mode}
                    onChange={(event) => update({ mode: event.target.value })}
                  >
                    {withCurrent(form.mode, MODE_OPTIONS).map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label>
                Açıklama
                <textarea
                  value={form.description}
                  maxLength={500}
                  onChange={(event) =>
                    update({ description: event.target.value })
                  }
                />
              </label>
              <label>
                İş hedefi
                <textarea
                  value={form.businessObjective}
                  placeholder="Örn. Ürün sorularını yanıtlamak ve uygun müşterileri satışa yönlendirmek"
                  onChange={(event) =>
                    update({ businessObjective: event.target.value })
                  }
                />
              </label>

              <div className="ai-status-actions">
                <span className="ai-note">Ajan durumu:</span>
                {data.agent.status === "active" ? (
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => void changeStatus("paused")}
                    disabled={statusBusy}
                  >
                    <PauseCircle size={15} aria-hidden="true" /> Duraklat
                  </button>
                ) : data.agent.status !== "archived" ? (
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => void changeStatus("active")}
                    disabled={statusBusy}
                  >
                    <Play size={15} aria-hidden="true" /> Etkinleştir
                  </button>
                ) : null}
                {data.agent.status !== "archived" && (
                  <button
                    type="button"
                    className="subtle-button danger"
                    onClick={() => setConfirmArchive(true)}
                    disabled={statusBusy}
                  >
                    <Archive size={15} aria-hidden="true" /> Arşivle
                  </button>
                )}
              </div>

              <div className="ai-tab-actions">
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => void saveGeneral()}
                  disabled={saving}
                >
                  {saving ? "Kaydediliyor…" : "Kaydet"}
                </button>
              </div>
            </section>
          )}

          {tab === "instructions" && (
            <section className="stack-card ai-detail-card">
              <h2>Talimatlar ve kişilik</h2>
              <label>
                Sistem talimatı
                <textarea
                  className="ai-textarea-tall"
                  value={form.systemInstruction}
                  placeholder="Ajanın rolünü, yapabileceklerini ve sınırlarını açıklayın."
                  onChange={(event) =>
                    update({ systemInstruction: event.target.value })
                  }
                />
              </label>
              <AiListEditor
                label="Davranış kuralları"
                items={form.behaviorRules}
                placeholder="Örn. Fiyat sorulduğunda güncel listeyi kullan"
                onChange={(items) => update({ behaviorRules: items })}
              />
              <AiListEditor
                label="Yasaklı konular"
                items={form.forbiddenTopics}
                placeholder="Örn. Tıbbi tavsiye"
                onChange={(items) => update({ forbiddenTopics: items })}
              />
              <h3 className="ai-subheading">Persona</h3>
              <div className="ai-form-grid">
                <label>
                  Ton
                  <select
                    value={form.persona.tone}
                    onChange={(event) =>
                      update({
                        persona: { ...form.persona, tone: event.target.value },
                      })
                    }
                  >
                    {withCurrent(form.persona.tone, [
                      { value: "professional", label: "Profesyonel" },
                      { value: "friendly", label: "Samimi" },
                      { value: "formal", label: "Resmi" },
                      { value: "casual", label: "Rahat" },
                    ]).map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Kişilik
                  <select
                    value={form.persona.personality}
                    onChange={(event) =>
                      update({
                        persona: {
                          ...form.persona,
                          personality: event.target.value,
                        },
                      })
                    }
                  >
                    {withCurrent(form.persona.personality, [
                      { value: "helpful", label: "Yardımsever" },
                      { value: "empathetic", label: "Empatik" },
                      { value: "expert", label: "Uzman" },
                      { value: "energetic", label: "Enerjik" },
                    ]).map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  İletişim tarzı
                  <select
                    value={form.persona.communicationStyle}
                    onChange={(event) =>
                      update({
                        persona: {
                          ...form.persona,
                          communicationStyle: event.target.value,
                        },
                      })
                    }
                  >
                    {withCurrent(form.persona.communicationStyle, [
                      { value: "clear", label: "Net ve sade" },
                      { value: "detailed", label: "Detaylı" },
                      { value: "concise", label: "Kısa ve öz" },
                      { value: "conversational", label: "Sohbet havasında" },
                    ]).map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Yanıt uzunluğu
                  <select
                    value={form.persona.responseLength}
                    onChange={(event) =>
                      update({
                        persona: {
                          ...form.persona,
                          responseLength: event.target.value,
                        },
                      })
                    }
                  >
                    {withCurrent(form.persona.responseLength, [
                      { value: "short", label: "Kısa" },
                      { value: "medium", label: "Orta" },
                      { value: "long", label: "Uzun" },
                    ]).map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Emoji kullanımı
                  <select
                    value={form.persona.emojiPolicy}
                    onChange={(event) =>
                      update({
                        persona: {
                          ...form.persona,
                          emojiPolicy: event.target.value,
                        },
                      })
                    }
                  >
                    {withCurrent(form.persona.emojiPolicy, [
                      { value: "none", label: "Kullanma" },
                      { value: "sparing", label: "Ölçülü" },
                      { value: "frequent", label: "Sık" },
                    ]).map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="ai-tab-actions">
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => void saveInstructions()}
                  disabled={saving}
                >
                  {saving ? "Kaydediliyor…" : "Kaydet"}
                </button>
              </div>
            </section>
          )}

          {tab === "examples" && (
            <section className="stack-card ai-detail-card">
              <h2>Örnek yanıtlar</h2>
              <p className="ai-note">
                Müşteri mesajı → ideal yanıt çiftleri, ajanın üslubunu ve
                içeriğini yönlendirir.
              </p>
              {form.exampleResponses.length === 0 && (
                <p className="ai-note">Henüz örnek eklenmedi.</p>
              )}
              <div className="ai-diff">
                {form.exampleResponses.map((example, index) => (
                  <div className="ai-example-pair" key={index}>
                    <label>
                      Müşteri mesajı
                      <textarea
                        value={example.customer}
                        onChange={(event) =>
                          update({
                            exampleResponses: form.exampleResponses.map(
                              (item, itemIndex) =>
                                itemIndex === index
                                  ? { ...item, customer: event.target.value }
                                  : item,
                            ),
                          })
                        }
                      />
                    </label>
                    <label>
                      İdeal yanıt
                      <textarea
                        value={example.reply}
                        onChange={(event) =>
                          update({
                            exampleResponses: form.exampleResponses.map(
                              (item, itemIndex) =>
                                itemIndex === index
                                  ? { ...item, reply: event.target.value }
                                  : item,
                            ),
                          })
                        }
                      />
                    </label>
                    <div>
                      <button
                        type="button"
                        className="subtle-button danger"
                        onClick={() =>
                          update({
                            exampleResponses: form.exampleResponses.filter(
                              (_, itemIndex) => itemIndex !== index,
                            ),
                          })
                        }
                      >
                        <Trash2 size={14} aria-hidden="true" /> Örneği kaldır
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              <div>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() =>
                    update({
                      exampleResponses: [
                        ...form.exampleResponses,
                        { customer: "", reply: "" },
                      ],
                    })
                  }
                >
                  <Plus size={15} aria-hidden="true" /> Örnek ekle
                </button>
              </div>
              <div className="ai-tab-actions">
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => void saveExamples()}
                  disabled={saving}
                >
                  {saving ? "Kaydediliyor…" : "Kaydet"}
                </button>
              </div>
            </section>
          )}

          {tab === "knowledge" && (
            <section className="stack-card ai-detail-card">
              <h2>Bilgi tabanları</h2>
              <p className="ai-note">
                Seçilen bilgi tabanlarındaki hazır belgeler, ajanın yanıtlarına
                kaynak olarak eklenir.
              </p>
              {knowledgeBases.length === 0 ? (
                <div className="empty-state">
                  <h2>Bilgi tabanı bulunamadı</h2>
                  <p>Önce Bilgi Tabanı bölümünden bir taban oluşturun.</p>
                  <Link className="primary-button" href="/app/ai-chats/knowledge">
                    Bilgi Tabanına git
                  </Link>
                </div>
              ) : (
                <div className="ai-check-list">
                  {knowledgeBases.map((base) => (
                    <label className="ai-checkbox-row" key={base.id}>
                      <input
                        type="checkbox"
                        checked={selectedKnowledge.includes(base.id)}
                        onChange={(event) =>
                          setSelectedKnowledge((current) =>
                            event.target.checked
                              ? [...current, base.id]
                              : current.filter((id) => id !== base.id),
                          )
                        }
                      />
                      <span>
                        <strong>{base.name}</strong>
                        {base.document_count != null && (
                          <small className="ai-note">
                            {" "}
                            · {String(base.document_count)} belge
                          </small>
                        )}
                      </span>
                    </label>
                  ))}
                </div>
              )}
              <div className="ai-tab-actions">
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => void saveKnowledge()}
                  disabled={saving || knowledgeBases.length === 0}
                >
                  {saving ? "Kaydediliyor…" : "Kaydet"}
                </button>
              </div>
            </section>
          )}

          {tab === "tools" && (
            <section className="stack-card ai-detail-card">
              <h2>Araç izinleri</h2>
              <p className="ai-note">
                “Yanıtı sonlandır” ve “İnsana devret” araçları her zaman
                açıktır ve kapatılamaz.
              </p>
              <div className="table-card ai-table-scroll ai-borderless">
                <table>
                  <caption className="sr-only">Araç izinleri</caption>
                  <thead>
                    <tr>
                      <th>Araç</th>
                      <th>Açıklama</th>
                      <th>İzin</th>
                    </tr>
                  </thead>
                  <tbody>
                    {AI_TOOL_DEFINITIONS.map((tool) => (
                      <tr key={tool.name}>
                        <td>
                          <strong>{tool.label}</strong>
                          <small className="ai-draft-hint">{tool.name}</small>
                        </td>
                        <td className="ai-note">{tool.description}</td>
                        <td>
                          <select
                            aria-label={`${tool.label} izni`}
                            value={form.toolPermissions[tool.name] ?? "allowed"}
                            onChange={(event) =>
                              update({
                                toolPermissions: {
                                  ...form.toolPermissions,
                                  [tool.name]: event.target.value,
                                },
                              })
                            }
                          >
                            <option value="allowed">İzinli</option>
                            <option value="approval">Onay gerekli</option>
                            <option value="denied">Engelli</option>
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="ai-tab-actions">
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => void saveTools()}
                  disabled={saving}
                >
                  {saving ? "Kaydediliyor…" : "Kaydet"}
                </button>
              </div>
            </section>
          )}

          {tab === "channels" && (
            <section className="stack-card ai-detail-card">
              <h2>Kanal atamaları</h2>
              <p className="ai-note">
                Bir kanal aynı anda yalnızca tek bir ajana atanabilir. Mod
                geçersiz kılma alanı boşsa ajanın genel modu kullanılır.
              </p>
              {channels.length === 0 ? (
                <div className="empty-state">
                  <h2>Kanal bulunamadı</h2>
                  <p>Önce Kanallar bölümünden bir kanal bağlayın.</p>
                  <Link className="primary-button" href="/app/channels">
                    Kanallara git
                  </Link>
                </div>
              ) : (
                <div className="ai-channel-list">
                  {channels.map((channel) => {
                    const selection = channelSelection[channel.id] ?? {
                      enabled: false,
                      modeOverride: "",
                    };
                    return (
                      <div className="ai-channel-row" key={channel.id}>
                        <label className="ai-checkbox-row">
                          <input
                            type="checkbox"
                            checked={selection.enabled}
                            onChange={(event) =>
                              setChannelSelection((current) => ({
                                ...current,
                                [channel.id]: {
                                  ...selection,
                                  enabled: event.target.checked,
                                },
                              }))
                            }
                          />
                          <span>
                            <strong>{channel.name}</strong>
                            <small className="ai-note">
                              {[channel.provider, channel.phoneNumber]
                                .filter(Boolean)
                                .join(" · ") || channel.platform || ""}
                            </small>
                          </span>
                        </label>
                        <select
                          aria-label={`${channel.name} için mod geçersiz kılma`}
                          value={selection.modeOverride}
                          disabled={!selection.enabled}
                          onChange={(event) =>
                            setChannelSelection((current) => ({
                              ...current,
                              [channel.id]: {
                                ...selection,
                                modeOverride: event.target.value,
                              },
                            }))
                          }
                        >
                          <option value="">Ajan varsayılanı</option>
                          <option value="observe">Gözlem</option>
                          <option value="copilot">Yardımcı pilot</option>
                          <option value="approval">Onay ile gönder</option>
                          <option value="autopilot">Otomatik pilot</option>
                        </select>
                      </div>
                    );
                  })}
                </div>
              )}
              <div className="ai-tab-actions">
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => void saveChannels()}
                  disabled={saving || channels.length === 0}
                >
                  {saving ? "Kaydediliyor…" : "Kaydet"}
                </button>
              </div>
            </section>
          )}

          {tab === "safety" && (
            <section className="stack-card ai-detail-card">
              <h2>Güvenlik ve devir kuralları</h2>
              <div className="ai-range-row">
                <label className="ai-range-label">
                  Güven eşiği
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={toNumber(form.confidenceThreshold)}
                    onChange={(event) =>
                      update({ confidenceThreshold: event.target.value })
                    }
                  />
                </label>
                <input
                  type="number"
                  className="ai-number-input"
                  min={0}
                  max={1}
                  step={0.05}
                  aria-label="Güven eşiği değeri"
                  value={form.confidenceThreshold}
                  onChange={(event) =>
                    update({ confidenceThreshold: event.target.value })
                  }
                />
              </div>
              <p className="ai-note">
                Ajanın güveni bu eşiğin altındaysa yanıt otomatik gönderilmez;
                konuşma insana devredilir veya öneri olarak sunulur.
              </p>

              <h3 className="ai-subheading">İnsana devir</h3>
              <div className="ai-check-list">
                <label className="ai-checkbox-row">
                  <input
                    type="checkbox"
                    checked={form.handoffOnHumanRequest}
                    onChange={(event) =>
                      update({ handoffOnHumanRequest: event.target.checked })
                    }
                  />
                  <span>Müşteri insan temsilci istediğinde devret</span>
                </label>
                <label className="ai-checkbox-row">
                  <input
                    type="checkbox"
                    checked={form.handoffOnNegativeSentiment}
                    onChange={(event) =>
                      update({
                        handoffOnNegativeSentiment: event.target.checked,
                      })
                    }
                  />
                  <span>Olumsuz duygu durumu algılandığında devret</span>
                </label>
                <label className="ai-checkbox-row">
                  <input
                    type="checkbox"
                    checked={form.handoffOnMissingKnowledge}
                    onChange={(event) =>
                      update({
                        handoffOnMissingKnowledge: event.target.checked,
                      })
                    }
                  />
                  <span>Bilgi tabanında yanıt bulunamadığında devret</span>
                </label>
              </div>
              <AiListEditor
                label="Kısıtlı niyetler (her zaman insana devredilir)"
                items={form.restrictedIntents}
                placeholder="Örn. iade talebi"
                onChange={(items) => update({ restrictedIntents: items })}
              />
              <div className="ai-form-grid">
                <label>
                  Üst üste en fazla AI mesajı
                  <input
                    type="number"
                    min={1}
                    value={form.maxConsecutiveAiMessages}
                    onChange={(event) =>
                      update({ maxConsecutiveAiMessages: event.target.value })
                    }
                  />
                </label>
                <label>
                  Yanıt gecikmesi (min, ms)
                  <input
                    type="number"
                    min={0}
                    step={100}
                    value={form.responseDelayMinMs}
                    onChange={(event) =>
                      update({ responseDelayMinMs: event.target.value })
                    }
                  />
                </label>
                <label>
                  Yanıt gecikmesi (maks, ms)
                  <input
                    type="number"
                    min={0}
                    step={100}
                    value={form.responseDelayMaxMs}
                    onChange={(event) =>
                      update({ responseDelayMaxMs: event.target.value })
                    }
                  />
                </label>
              </div>
              <h3 className="ai-subheading">Çalışma saatleri</h3>
              <p className="ai-note">
                Hiçbir gün işaretlenmezse ajan her saatte çalışır. Saatler
                dışında otomatik gönderim durur; yanıt taslak olarak kaydedilir
                ve ekip onayına düşer.
              </p>
              <div className="ai-form-grid">
                <label>
                  Saat dilimi
                  <input
                    value={form.workingHoursTimezone}
                    placeholder="Europe/Istanbul"
                    onChange={(event) =>
                      update({ workingHoursTimezone: event.target.value })
                    }
                  />
                </label>
              </div>
              <div className="ai-working-days">
                {WEEKDAYS.map((day) => {
                  const value = form.workingHoursDays[day.key]!;
                  return (
                    <div className="ai-working-day" key={day.key}>
                      <label className="ai-checkbox-row">
                        <input
                          type="checkbox"
                          checked={value.enabled}
                          onChange={(event) =>
                            updateWorkingDay(day.key, {
                              enabled: event.target.checked,
                            })
                          }
                        />
                        {day.label}
                      </label>
                      <input
                        type="time"
                        value={value.start}
                        disabled={!value.enabled}
                        aria-label={`${day.label} başlangıç`}
                        onChange={(event) =>
                          updateWorkingDay(day.key, {
                            start: event.target.value,
                          })
                        }
                      />
                      <span aria-hidden="true">–</span>
                      <input
                        type="time"
                        value={value.end}
                        disabled={!value.enabled}
                        aria-label={`${day.label} bitiş`}
                        onChange={(event) =>
                          updateWorkingDay(day.key, { end: event.target.value })
                        }
                      />
                    </div>
                  );
                })}
              </div>
              <div className="ai-tab-actions">
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => void saveSafety()}
                  disabled={saving}
                >
                  {saving ? "Kaydediliyor…" : "Kaydet"}
                </button>
              </div>
            </section>
          )}

          {tab === "model" && (
            <section className="stack-card ai-detail-card">
              <h2>Model ve limitler</h2>
              <div className="ai-form-grid">
                <label>
                  Model
                  <AiModelInput
                    value={form.model}
                    placeholder="openai/gpt-4o-mini"
                    onChange={(value) => update({ model: value })}
                  />
                </label>
                <label>
                  Yedek model
                  <AiModelInput
                    value={form.fallbackModel}
                    placeholder="google/gemini-flash-1.5"
                    onChange={(value) => update({ fallbackModel: value })}
                  />
                </label>
                <label>
                  Sıcaklık (temperature)
                  <input
                    type="number"
                    min={0}
                    max={2}
                    step={0.1}
                    value={form.temperature}
                    onChange={(event) =>
                      update({ temperature: event.target.value })
                    }
                  />
                </label>
                <label>
                  En fazla adım
                  <input
                    type="number"
                    min={1}
                    value={form.maxSteps}
                    onChange={(event) =>
                      update({ maxSteps: event.target.value })
                    }
                  />
                </label>
                <label>
                  Çalışma başına maksimum maliyet (USD)
                  <input
                    type="number"
                    min={0}
                    step={0.01}
                    value={form.maxCostPerRunUsd}
                    onChange={(event) =>
                      update({ maxCostPerRunUsd: event.target.value })
                    }
                  />
                </label>
                <label>
                  Maksimum çıktı token
                  <input
                    type="number"
                    min={0}
                    value={form.maxOutputTokens}
                    placeholder="Varsayılan"
                    onChange={(event) =>
                      update({ maxOutputTokens: event.target.value })
                    }
                  />
                </label>
              </div>
              <div className="ai-check-list">
                <label className="ai-checkbox-row">
                  <input
                    type="checkbox"
                    checked={form.visionEnabled}
                    onChange={(event) =>
                      update({ visionEnabled: event.target.checked })
                    }
                  />
                  <span>Görsel anlama (vision) etkin</span>
                </label>
                <p className="ai-note">
                  Müşterinin gönderdiği görseller (tarama sonucu temiz, en
                  fazla 2 görsel / 4&nbsp;MB) modele iletilir. Vision destekli
                  bir model seçtiğinizden emin olun.
                </p>
                <label className="ai-checkbox-row">
                  <input
                    type="checkbox"
                    checked={form.webSearchEnabled}
                    onChange={(event) =>
                      update({ webSearchEnabled: event.target.checked })
                    }
                  />
                  <span>Web araması etkin</span>
                </label>
                <p className="ai-note">
                  Ajan gerektiğinde web&apos;de arama yapabilir (çalıştırma
                  başına ek maliyet). Fiyat ve politika bilgileri için her
                  zaman bilgi tabanı önceliklidir; web içeriği güvenilmez veri
                  olarak işlenir.
                </p>
              </div>
              <div className="ai-tab-actions">
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => void saveModel()}
                  disabled={saving}
                >
                  {saving ? "Kaydediliyor…" : "Kaydet"}
                </button>
              </div>
            </section>
          )}

          {tab === "versions" && (
            <section className="stack-card ai-detail-card">
              <h2>Sürüm geçmişi</h2>
              {hasDraft ? (
                <p className="ai-note">
                  v{data.draft!.version} numaralı taslak bekliyor. Yayınlamak
                  yeni sürümü tüm bağlı kanallarda etkinleştirir.
                </p>
              ) : (
                <p className="ai-note">
                  Bekleyen taslak yok. Herhangi bir sekmede değişiklik
                  kaydettiğinizde otomatik olarak taslak oluşturulur.
                </p>
              )}
              {hasDraft && (
                <div>
                  <button
                    type="button"
                    className="primary-button"
                    onClick={() => void publish()}
                    disabled={publishing}
                  >
                    <Rocket size={15} aria-hidden="true" />
                    {publishing ? "Yayınlanıyor…" : "Taslağı yayınla"}
                  </button>
                </div>
              )}
              {versions.length === 0 ? (
                <div className="empty-state">
                  <History aria-hidden="true" />
                  <h2>Henüz sürüm yok</h2>
                  <p>İlk yapılandırmayı kaydedip yayınladığınızda sürümler burada listelenir.</p>
                </div>
              ) : (
                <div className="table-card ai-table-scroll ai-borderless">
                  <table>
                    <caption className="sr-only">Ajan sürümleri</caption>
                    <thead>
                      <tr>
                        <th>Sürüm</th>
                        <th>Durum</th>
                        <th>Mod</th>
                        <th>Model</th>
                        <th>Yayın tarihi</th>
                        <th>İşlemler</th>
                      </tr>
                    </thead>
                    <tbody>
                      {versions.map((version) => (
                        <tr key={version.id}>
                          <td>
                            <strong>v{version.version}</strong>
                          </td>
                          <td>
                            <span
                              className={`status-pill ${
                                version.status === "published"
                                  ? "approved"
                                  : version.status === "draft"
                                    ? "pending"
                                    : "archived"
                              }`}
                            >
                              {version.status === "published"
                                ? "Yayında"
                                : version.status === "draft"
                                  ? "Taslak"
                                  : "Emekli"}
                            </span>
                          </td>
                          <td>{agentModeLabel(version.mode)}</td>
                          <td>
                            <code className="ai-model-code">
                              {version.model ?? "—"}
                            </code>
                          </td>
                          <td>{formatAiDate(version.published_at)}</td>
                          <td>
                            {version.status === "retired" && (
                              <button
                                type="button"
                                className="subtle-button"
                                onClick={() => void rollback(version.version)}
                                disabled={publishing}
                              >
                                <History size={14} aria-hidden="true" /> Bu
                                sürüme geri dön
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}
        </>
      )}

      {confirmArchive && data && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setConfirmArchive(false);
          }}
        >
          <section
            className="modal-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ai-agent-archive-title"
          >
            <h2 id="ai-agent-archive-title">Ajan arşivlensin mi?</h2>
            <p>
              <strong>{data.agent.name}</strong> yanıt üretmeyi durduracak.
              Sürümler ve çalışma geçmişi korunur.
            </p>
            <div className="modal-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => setConfirmArchive(false)}
                autoFocus
              >
                Vazgeç
              </button>
              <button
                type="button"
                className="primary-button ai-danger-button"
                onClick={() => void changeStatus("archived")}
                disabled={statusBusy}
              >
                <Archive size={15} aria-hidden="true" />
                {statusBusy ? "Arşivleniyor…" : "Arşivle"}
              </button>
            </div>
          </section>
        </div>
      )}
    </AppFrame>
  );
}

function AiListEditor({
  label,
  items,
  placeholder,
  onChange,
}: {
  label: string;
  items: string[];
  placeholder?: string;
  onChange: (items: string[]) => void;
}) {
  const [draft, setDraft] = useState("");

  function add() {
    const value = draft.trim();
    if (!value) return;
    onChange([...items, value]);
    setDraft("");
  }

  return (
    <div className="ai-list-editor">
      <span className="ai-list-label">{label}</span>
      <div className="ai-list-add">
        <input
          value={draft}
          placeholder={placeholder}
          aria-label={`${label} — yeni madde`}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              add();
            }
          }}
        />
        <button type="button" className="secondary-button" onClick={add}>
          <Plus size={14} aria-hidden="true" /> Ekle
        </button>
      </div>
      {items.length === 0 ? (
        <p className="ai-note">Henüz madde eklenmedi.</p>
      ) : (
        <ul className="ai-chip-list">
          {items.map((item, index) => (
            <li className="ai-chip" key={`${item}-${index}`}>
              {item}
              <button
                type="button"
                aria-label={`“${item}” maddesini kaldır`}
                onClick={() =>
                  onChange(items.filter((_, itemIndex) => itemIndex !== index))
                }
              >
                <X size={13} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
