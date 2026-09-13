"use client";

import Link from "next/link";
import {
  ArrowLeftRight,
  Check,
  CircleAlert,
  Columns3,
  ExternalLink,
  Filter,
  Grid2X2,
  HeartPulse,
  List,
  MessageCircleMore,
  Plus,
  RotateCcw,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Unplug,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { apiJson } from "../lib/api";
import { AppFrame } from "./app-frame";
import {
  deriveOpenChannelStatus,
  filterOpenChannelItems,
  getCrmRuleLabel,
  getOpenChannelDirection,
  getStatusCounts,
  type OpenChannelDirection,
  type OpenChannelPresentationItem,
  type OpenChannelStatus,
  type OpenChannelStatusFilter,
} from "./open-channels-presentation";

type Connection = {
  id: string;
  name: string;
  provider?: string;
  portalUrl?: string | null;
  status?: string;
  authMode?: string;
};
type Channel = {
  id: string;
  name: string;
  connectionStatus: string;
  healthState: string;
  phoneNumber?: string | null;
  provider?: string;
};
type OpenLine = {
  id: string;
  name: string;
  active: boolean;
  crmEnabled: boolean;
  crmCreate: "lead" | "deal" | "none";
  queueUserIds: string[];
};
type PipelineRow = {
  pipeline_external_id: string;
  pipeline_name: string;
  stage_external_id: string;
  stage_name: string;
};
type OpenChannelsSettings = {
  brixchatChannelId?: string;
  lineId?: string;
  incomingEnabled?: boolean;
  outgoingEnabled?: boolean;
  deliveryStatusSync?: boolean;
  sessionCloseSync?: boolean;
  autoCrmMode?: "disabled" | "lead" | "contact_and_deal";
  crmSourceId?: string;
  pipelineId?: string;
  stageId?: string;
  timelinePolicy?: "per_message" | "session_summary" | "disabled";
};
type OpenChannelBinding = {
  id: string;
  brixchat_channel_id: string;
  connector_id: string;
  line_id: string;
  status: string;
  settings: OpenChannelsSettings;
  last_event_at?: string;
  last_success_at?: string;
  last_error?: string;
};
type ReviewJob = {
  id: string;
  conversation_id: string;
  job_type: string;
  status: "manual_review" | "dead_letter";
  attempt_count: number;
  max_attempts: number;
  last_error?: string | null;
  contact_name?: string | null;
  normalized_phone?: string | null;
  channel_name?: string | null;
  updated_at: string;
  related_job_count?: number;
  connectionId: string;
};
type ReviewMeta = {
  totalCases: number;
  totalJobs: number;
  limit: number;
  offset: number;
};
type CrmContactExclusion = {
  id: string;
  normalized_phone: string;
  display_name?: string | null;
  reason: string;
  created_at: string;
  created_by_name?: string | null;
  connectionId: string;
};
type State = {
  bitrix_mode?: "crm_context" | "open_channels" | "both";
  open_channels_status?: string;
  open_channels_settings?: OpenChannelsSettings;
  connector_id?: string;
  line_id?: string;
  status?: string;
  last_event_at?: string;
  last_success_at?: string;
  last_error?: string;
  bindings?: OpenChannelBinding[];
};
type ConnectionSummary = {
  connection: Connection;
  state: State | null;
  lines: OpenLine[];
  reviewJobs: ReviewJob[];
  reviewMeta: ReviewMeta;
  crmExclusions: CrmContactExclusion[];
  loadError?: string;
};
type OpenChannelItem = OpenChannelPresentationItem & {
  connectionId?: string;
  channelId?: string;
  summary: ConnectionSummary;
  channel: Channel | null;
  line: OpenLine | null;
  binding?: OpenChannelBinding | null;
  mode: "crm_context" | "open_channels" | "both";
  settings: OpenChannelsSettings;
  lastActivity?: string;
  loadError?: string;
};
type ViewMode = "list" | "kanban";

const VIEW_STORAGE_KEY = "brixchat_open_channels_view";
const initialSettings: OpenChannelsSettings = {
  incomingEnabled: true,
  outgoingEnabled: true,
  deliveryStatusSync: true,
  sessionCloseSync: true,
  autoCrmMode: "contact_and_deal",
  crmSourceId: "WEB",
  pipelineId: "8",
  stageId: "C8:NEW",
  timelinePolicy: "session_summary",
};
const statusMeta: Record<
  OpenChannelStatus,
  { label: string; description: string }
> = {
  active: { label: "Aktif", description: "Bağlantı kullanıma hazır" },
  warning: {
    label: "Kontrol gerekli",
    description: "Yapılandırmayı inceleyin",
  },
  disabled: { label: "Devre dışı", description: "Mesaj akışı durduruldu" },
};
const flowToggles: Array<{
  key:
    | "incomingEnabled"
    | "outgoingEnabled"
    | "deliveryStatusSync"
    | "sessionCloseSync";
  label: string;
  hint: string;
}> = [
  {
    key: "incomingEnabled",
    label: "Gelen mesajlar",
    hint: "BrixChat → Bitrix24",
  },
  {
    key: "outgoingEnabled",
    label: "Operatör yanıtları",
    hint: "Bitrix24 → BrixChat",
  },
  {
    key: "deliveryStatusSync",
    label: "Teslimat durumu",
    hint: "Durumları Bitrix24'e ilet",
  },
  {
    key: "sessionCloseSync",
    label: "Oturum kapanışı",
    hint: "Kapanış durumunu eşitle",
  },
];

function safeDate(value?: string) {
  if (!value) return "Henüz doğrulanmadı";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Henüz doğrulanmadı";
  return new Intl.DateTimeFormat("tr-TR", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function shorten(value?: string) {
  if (!value) return "Henüz kaydedilmedi";
  if (value.length <= 28) return value;
  return `${value.slice(0, 15)}…${value.slice(-8)}`;
}

function ChannelCell({ item }: { item: OpenChannelItem }) {
  return (
    <div className="oc-channel-summary">
      <span className="oc-provider-mark whatsapp" aria-hidden="true">
        <MessageCircleMore size={19} />
      </span>
      <span>
        <strong>{item.channelName}</strong>
      </span>
    </div>
  );
}

function StatusBadge({ status }: { status: OpenChannelStatus }) {
  return (
    <span className={`oc-status-badge ${status}`}>
      <span aria-hidden="true" />
      {statusMeta[status].label}
    </span>
  );
}

export function OpenChannelsWorkspace() {
  const [summaries, setSummaries] = useState<ConnectionSummary[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [settledQuery, setSettledQuery] = useState("");
  const [statusFilter, setStatusFilter] =
    useState<OpenChannelStatusFilter>("all");
  const [directionFilter, setDirectionFilter] = useState<
    "all" | OpenChannelDirection
  >("all");
  const [crmFilter, setCrmFilter] = useState<
    "all" | NonNullable<OpenChannelsSettings["autoCrmMode"]>
  >("all");
  const [filterOpen, setFilterOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [mode, setMode] = useState<"crm_context" | "open_channels" | "both">(
    "both",
  );
  const [settings, setSettings] =
    useState<OpenChannelsSettings>(initialSettings);
  const [pipelines, setPipelines] = useState<PipelineRow[]>([]);
  const [reviewInputs, setReviewInputs] = useState<
    Record<string, { entityType: "lead" | "contact"; externalId: string }>
  >({});
  const [exclusionDraft, setExclusionDraft] = useState({
    phone: "",
    displayName: "",
    reason: "Kurum içi çalışan hattı",
  });
  const [view, setView] = useState<ViewMode>(() => {
    if (typeof window === "undefined") return "list";
    try {
      const saved = window.localStorage.getItem(VIEW_STORAGE_KEY);
      return saved === "kanban" ? "kanban" : "list";
    } catch {
      return "list";
    }
  });

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [connectionResult, channelResult] = await Promise.all([
        apiJson<{ data: Connection[] }>("/api/v1/integrations"),
        apiJson<{ data: Channel[] }>("/api/v1/channels"),
      ]);
      const activeChannels = channelResult.data.filter(
        (channel) =>
          channel.connectionStatus === "ACTIVE" &&
          channel.healthState !== "UNHEALTHY",
      );
      const bitrixConnections = connectionResult.data.filter(
        (connection) =>
          connection.provider === "bitrix24" ||
          connection.portalUrl?.includes("bitrix24") ||
          connection.authMode === "fake",
      );
      const nextSummaries = await Promise.all(
        bitrixConnections.map(
          async (connection): Promise<ConnectionSummary> => {
            const [stateResult, lineResult, jobResult, exclusionResult] =
              await Promise.allSettled([
                apiJson<{ data: State | null }>(
                  `/api/v1/integrations/${connection.id}/open-channels`,
                ),
                apiJson<{ data: OpenLine[] }>(
                  `/api/v1/integrations/${connection.id}/open-channels/lines`,
                ),
                apiJson<{
                  data: Omit<ReviewJob, "connectionId">[];
                  meta: ReviewMeta;
                }>(
                  `/api/v1/integrations/${connection.id}/open-channels/jobs?limit=100`,
                ),
                apiJson<{ data: Omit<CrmContactExclusion, "connectionId">[] }>(
                  `/api/v1/integrations/${connection.id}/open-channels/crm-exclusions`,
                ),
              ]);
            const errors = [stateResult, lineResult, jobResult, exclusionResult]
              .filter(
                (result): result is PromiseRejectedResult =>
                  result.status === "rejected",
              )
              .map((result) =>
                result.reason instanceof Error
                  ? result.reason.message
                  : "Bağlantı ayrıntıları yüklenemedi.",
              );
            return {
              connection,
              state:
                stateResult.status === "fulfilled"
                  ? stateResult.value.data
                  : null,
              lines:
                lineResult.status === "fulfilled" ? lineResult.value.data : [],
              reviewJobs:
                jobResult.status === "fulfilled"
                  ? jobResult.value.data.map((job) => ({
                      ...job,
                      connectionId: connection.id,
                    }))
                  : [],
              reviewMeta:
                jobResult.status === "fulfilled"
                  ? jobResult.value.meta
                  : { totalCases: 0, totalJobs: 0, limit: 100, offset: 0 },
              crmExclusions:
                exclusionResult.status === "fulfilled"
                  ? exclusionResult.value.data.map((exclusion) => ({
                      ...exclusion,
                      connectionId: connection.id,
                    }))
                  : [],
              ...(errors.length ? { loadError: errors[0] } : {}),
            };
          },
        ),
      );
      setChannels(activeChannels);
      setSummaries(nextSummaries);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Open Channels bağlantıları yüklenemedi.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    const timer = window.setTimeout(() => setSettledQuery(query), 150);
    return () => window.clearTimeout(timer);
  }, [query]);

  const items = useMemo<OpenChannelItem[]>(
    () =>
      summaries.map((summary) => {
        const state = summary.state;
        const nextSettings = {
          ...initialSettings,
          ...(state?.open_channels_settings ?? {}),
        };
        const channel =
          channels.find(
            (candidate) => candidate.id === nextSettings.brixchatChannelId,
          ) ?? null;
        const lineId = nextSettings.lineId ?? state?.line_id;
        const line =
          summary.lines.find((candidate) => candidate.id === lineId) ?? null;
        const direction = getOpenChannelDirection(
          nextSettings.incomingEnabled,
          nextSettings.outgoingEnabled,
        );
        return {
          id: summary.connection.id,
          connectionName: summary.connection.name || "Bitrix24 bağlantısı",
          channelName: channel?.name ?? "BrixChat kanalı seçilmedi",
          lineName: line?.name ?? lineId ?? "Açık hat seçilmedi",
          connectorId: state?.connector_id ?? "",
          crmLabel: getCrmRuleLabel(nextSettings.autoCrmMode),
          direction,
          status: summary.loadError
            ? "warning"
            : deriveOpenChannelStatus(state),
          summary,
          channel,
          line,
          mode: state?.bitrix_mode ?? "both",
          settings: nextSettings,
          ...(state?.last_success_at || state?.last_event_at
            ? { lastActivity: state.last_success_at ?? state.last_event_at! }
            : {}),
          ...(summary.loadError ? { loadError: summary.loadError } : {}),
        };
      }),
    [channels, summaries],
  );
  const reviewJobs = useMemo(
    () => summaries.flatMap((summary) => summary.reviewJobs),
    [summaries],
  );
  const reviewTotals = useMemo(
    () =>
      summaries.reduce(
        (total, summary) => ({
          cases: total.cases + summary.reviewMeta.totalCases,
          jobs: total.jobs + summary.reviewMeta.totalJobs,
        }),
        { cases: 0, jobs: 0 },
      ),
    [summaries],
  );
  const crmExclusions = summaries[0]?.crmExclusions ?? [];

  const channelItems = useMemo<OpenChannelItem[]>(() => {
    const firstSummary = summaries[0];
    if (!firstSummary) return [];
    const bindingByChannel = new Map<
      string,
      { summary: ConnectionSummary; binding: OpenChannelBinding }
    >();
    for (const summary of summaries)
      for (const binding of summary.state?.bindings ?? [])
        bindingByChannel.set(binding.brixchat_channel_id, {
          summary,
          binding,
        });
    return channels.map((channel) => {
      const mapped = bindingByChannel.get(channel.id);
      const summary = mapped?.summary ?? firstSummary;
      const binding = mapped?.binding ?? null;
      const state = summary.state;
      const inheritedSettings: OpenChannelsSettings = {
        ...initialSettings,
        ...(state?.open_channels_settings ?? {}),
        ...(binding?.settings ?? {}),
      };
      delete inheritedSettings.lineId;
      delete inheritedSettings.brixchatChannelId;
      delete (inheritedSettings as Record<string, unknown>)
        .responsibleExternalUserId;
      const nextSettings: OpenChannelsSettings = {
        ...inheritedSettings,
        brixchatChannelId: channel.id,
        ...(binding?.line_id ? { lineId: binding.line_id } : {}),
      };
      const lineId = binding?.line_id ?? nextSettings.lineId;
      const line =
        summary.lines.find((candidate) => candidate.id === lineId) ?? null;
      const direction = getOpenChannelDirection(
        nextSettings.incomingEnabled,
        nextSettings.outgoingEnabled,
      );
      return {
        id: `${summary.connection.id}:${channel.id}`,
        connectionId: summary.connection.id,
        channelId: channel.id,
        connectionName: summary.connection.name || "Bitrix24 bağlantısı",
        channelName: channel.name,
        lineName: line?.name ?? lineId ?? "Açık hat oluşturulmadı",
        connectorId: binding?.connector_id ?? state?.connector_id ?? "",
        crmLabel: getCrmRuleLabel(nextSettings.autoCrmMode),
        direction,
        status: summary.loadError
          ? "warning"
          : deriveOpenChannelStatus({
              open_channels_status: binding?.status ?? "disabled",
              status: binding?.status ?? "disabled",
            }),
        summary,
        channel,
        line,
        binding,
        mode: state?.bitrix_mode ?? "both",
        settings: nextSettings,
        ...(binding?.last_success_at || binding?.last_event_at
          ? {
              lastActivity: binding.last_success_at ?? binding.last_event_at!,
            }
          : {}),
        ...(summary.loadError ? { loadError: summary.loadError } : {}),
      };
    });
  }, [channels, summaries]);
  const displayedItems = channelItems.length ? channelItems : items;

  const counts = useMemo(
    () => getStatusCounts(displayedItems),
    [displayedItems],
  );
  const filteredItems = useMemo(
    () =>
      filterOpenChannelItems(displayedItems, settledQuery, statusFilter).filter(
        (item) =>
          (directionFilter === "all" || item.direction === directionFilter) &&
          (crmFilter === "all" || item.settings.autoCrmMode === crmFilter),
      ),
    [crmFilter, directionFilter, displayedItems, settledQuery, statusFilter],
  );
  const activeFilterCount =
    Number(directionFilter !== "all") + Number(crmFilter !== "all");
  const editingItem =
    displayedItems.find((item) => item.id === editingId) ?? null;
  const pipelineOptions = useMemo(() => {
    const unique = new Map<string, string>();
    for (const row of pipelines)
      unique.set(row.pipeline_external_id, row.pipeline_name);
    return [...unique.entries()];
  }, [pipelines]);
  const stageOptions = pipelines.filter(
    (row) => row.pipeline_external_id === settings.pipelineId,
  );

  function changeView(nextView: ViewMode) {
    setView(nextView);
    try {
      window.localStorage.setItem(VIEW_STORAGE_KEY, nextView);
    } catch {
      // The visual preference does not block the workflow.
    }
  }

  function clearFilters() {
    setQuery("");
    setSettledQuery("");
    setStatusFilter("all");
    setDirectionFilter("all");
    setCrmFilter("all");
  }

  async function openEditor(item: OpenChannelItem) {
    setEditingId(item.id);
    setMode(item.mode);
    setSettings(item.settings);
    setPipelines([]);
    setError("");
    setNotice("");
    try {
      const result = await apiJson<{ data: PipelineRow[] }>(
        `/api/v1/integrations/${item.connectionId ?? item.id}/pipelines`,
      );
      setPipelines(result.data);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "CRM pipeline seçenekleri yüklenemedi.",
      );
    }
  }

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      await load();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "İşlem tamamlanamadı.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function retryReviewJob(job: ReviewJob) {
    if (!window.confirm("Bu başarısız Bitrix işi yeniden denensin mi?")) return;
    await run(async () => {
      await apiJson(
        `/api/v1/integrations/${job.connectionId}/open-channels/jobs/${job.id}/retry`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ confirm: "RETRY" }),
        },
      );
      setNotice("Bitrix işi yeniden işleme kuyruğuna alındı.");
    });
  }

  async function resolveReviewJob(job: ReviewJob) {
    const input = reviewInputs[job.id] ?? {
      entityType: "lead" as const,
      externalId: "",
    };
    if (!/^\d+$/.test(input.externalId)) {
      setError("Geçerli bir sayısal Bitrix CRM kayıt ID'si girin.");
      return;
    }
    if (
      !window.confirm(
        `Bu konuşma Bitrix ${input.entityType === "lead" ? "Lead" : "Kişi"} #${input.externalId} kaydına bağlanacak. Devam edilsin mi?`,
      )
    )
      return;
    await run(async () => {
      await apiJson(
        `/api/v1/integrations/${job.connectionId}/open-channels/jobs/${job.id}/resolve`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            confirm: "LINK_CRM_ENTITY",
            entityType: input.entityType,
            externalId: input.externalId,
          }),
        },
      );
      setNotice(
        "CRM eşleşmesi kaydedildi; Bitrix senkronizasyonu yeniden başlatıldı.",
      );
    });
  }

  async function archiveReviewJob(job: ReviewJob) {
    if (
      !window.confirm(
        "Bu iş arşivlenecek ve otomatik olarak tekrar çalışmayacak. Devam edilsin mi?",
      )
    )
      return;
    await run(async () => {
      await apiJson(
        `/api/v1/integrations/${job.connectionId}/open-channels/jobs/${job.id}/archive`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ confirm: "ARCHIVE" }),
        },
      );
      setNotice("Bitrix inceleme kaydı arşivlendi.");
    });
  }

  async function addCrmExclusion() {
    const connectionId = summaries[0]?.connection.id;
    if (!connectionId) return;
    if (!exclusionDraft.phone.trim()) {
      setError("Geçerli bir çalışan telefon numarası girin.");
      return;
    }
    if (
      !window.confirm(
        "Bu numara CRM eşleştirme ve oluşturma işlemlerinin dışında tutulacak; bekleyen işleri arşivlenecek. Devam edilsin mi?",
      )
    )
      return;
    await run(async () => {
      const result = await apiJson<{
        data: { archivedJobCount: number };
      }>(`/api/v1/integrations/${connectionId}/open-channels/crm-exclusions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...exclusionDraft,
          archivePendingJobs: true,
        }),
      });
      setExclusionDraft({
        phone: "",
        displayName: "",
        reason: "Kurum içi çalışan hattı",
      });
      setNotice(
        `CRM istisnası kaydedildi; ${result.data.archivedJobCount} bekleyen mesaj işi arşivlendi.`,
      );
    });
  }

  async function removeCrmExclusion(exclusion: CrmContactExclusion) {
    if (
      !window.confirm(
        `${exclusion.normalized_phone} yeniden CRM işlemlerine dahil edilsin mi?`,
      )
    )
      return;
    await run(async () => {
      await apiJson(
        `/api/v1/integrations/${exclusion.connectionId}/open-channels/crm-exclusions/${exclusion.id}`,
        { method: "DELETE" },
      );
      setNotice(
        "CRM istisnası kaldırıldı. Yeni mesajlar normal kurallarla işlenecek.",
      );
    });
  }

  async function saveSettingsRequest(item: OpenChannelItem) {
    const connectionId = item.connectionId ?? item.id;
    // timelinePolicy isn't user-editable here: it's implied by `mode`. Omit
    // whatever stale value was loaded from an existing binding so the
    // backend recomputes it from the selected mode instead of silently
    // carrying over a value from a previous save.
    const { timelinePolicy: _timelinePolicy, ...settingsForSubmit } =
      settings;
    await apiJson(`/api/v1/integrations/${connectionId}/open-channels`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode,
        ...settingsForSubmit,
        brixchatChannelId: item.channelId ?? settings.brixchatChannelId,
        incomingEnabled: settings.incomingEnabled ?? true,
        outgoingEnabled: settings.outgoingEnabled ?? true,
        deliveryStatusSync: settings.deliveryStatusSync ?? true,
        sessionCloseSync: settings.sessionCloseSync ?? true,
      }),
    });
  }

  async function save() {
    if (!editingItem) return;
    await run(async () => {
      await saveSettingsRequest(editingItem);
      setNotice("Open Channels ve otomatik CRM ayarları kaydedildi.");
    });
  }

  async function register() {
    if (!editingItem) return;
    await run(async () => {
      await apiJson(
        `/api/v1/integrations/${editingItem.connectionId ?? editingItem.id}/open-channels/register`,
        { method: "POST" },
      );
      setNotice("Bitrix24 connector kaydedildi.");
    });
  }

  async function activate() {
    if (!editingItem?.channelId) return;
    if (
      !window.confirm(
        "Seçili Bitrix açık hattı etkinleştirilecek ve yeni mesajlar CRM politikasına göre işlenecek. Devam edilsin mi?",
      )
    )
      return;
    await run(async () => {
      await saveSettingsRequest(editingItem);
      await apiJson(
        `/api/v1/integrations/${editingItem.connectionId ?? editingItem.id}/open-channels/activate`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            confirm: "ACTIVATE",
            channelId: editingItem.channelId,
          }),
        },
      );
      setNotice("Bitrix24 Open Channels aktif ve kullanıma hazır.");
    });
  }

  async function deactivate() {
    if (!editingItem?.channelId) return;
    if (
      !window.confirm(
        "Connector devre dışı bırakılacak. Geçmiş konuşmalar ve CRM bağlantıları korunacak. Devam edilsin mi?",
      )
    )
      return;
    await run(async () => {
      await apiJson(
        `/api/v1/integrations/${editingItem.connectionId ?? editingItem.id}/open-channels/deactivate`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            confirm: "DEACTIVATE",
            channelId: editingItem.channelId,
          }),
        },
      );
      setNotice("Connector devre dışı bırakıldı; geçmiş veriler korundu.");
    });
  }

  async function health(item: OpenChannelItem) {
    if (!item.channelId) return;
    await run(async () => {
      await apiJson(
        `/api/v1/integrations/${item.connectionId ?? item.id}/open-channels/health`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ channelId: item.channelId }),
        },
      );
      setNotice("Bitrix24 connector sağlık testi başarıyla tamamlandı.");
    });
  }

  async function ensureChannel() {
    if (!editingItem?.channelId) return;
    if (
      !window.confirm(
        "Bitrix24 içinde bu WhatsApp hattına özel yeni bir Open Channel oluşturulacak ve bağlanacak. Devam edilsin mi?",
      )
    )
      return;
    await run(async () => {
      await apiJson(
        `/api/v1/integrations/${editingItem.connectionId ?? editingItem.id}/open-channels/ensure`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            channelId: editingItem.channelId,
            confirm: "CREATE_NEW",
          }),
        },
      );
      setNotice(
        "WhatsApp hattı için ayrı Bitrix24 Open Channel oluşturuldu ve etkinleştirildi.",
      );
    });
  }

  function renderConnectionActions(item: OpenChannelItem) {
    return (
      <div className="oc-row-actions">
        <button
          type="button"
          className="oc-secondary-button"
          onClick={() => void openEditor(item)}
        >
          <Settings2 size={15} />
          Yönet
        </button>
      </div>
    );
  }

  return (
    <AppFrame
      title="Bitrix24 Open Channels"
      subtitle="WhatsApp kanallarınızın Bitrix24 bağlantılarını tek ekrandan yönetin."
      actions={
        <Link
          className="primary-button compact-button"
          href="/app/integrations/bitrix24/connect"
        >
          <Plus size={16} /> Bağlantı ekle
        </Link>
      }
    >
      <div className="open-channels-page">
        <nav className="oc-breadcrumb" aria-label="Sayfa yolu">
          <Link href="/app/integrations">Entegrasyonlar</Link>
          <span>/</span>
          <Link href="/app/integrations/bitrix24">Bitrix24</Link>
          <span>/</span>
          <strong>Open Channels</strong>
        </nav>

        {summaries.length > 0 && (
          <section
            className="oc-connections-panel oc-exclusions-panel"
            aria-labelledby="oc-exclusions-title"
          >
            <header>
              <div>
                <h2 id="oc-exclusions-title">CRM dışında tutulan numaralar</h2>
                <p>
                  Çalışan ve kurum içi hatlar Lead/Kişi aramasına girmez. Kural
                  mevcut ve daha sonra bağlanacak tüm WhatsApp kanallarında
                  geçerlidir.
                </p>
              </div>
              <span>{crmExclusions.length}</span>
            </header>
            <div className="oc-exclusion-form">
              <input
                aria-label="Çalışan telefon numarası"
                placeholder="+90 5xx xxx xx xx"
                disabled={busy}
                value={exclusionDraft.phone}
                onChange={(event) =>
                  setExclusionDraft((current) => ({
                    ...current,
                    phone: event.target.value,
                  }))
                }
              />
              <input
                aria-label="Çalışan adı"
                placeholder="Ad soyad"
                disabled={busy}
                value={exclusionDraft.displayName}
                onChange={(event) =>
                  setExclusionDraft((current) => ({
                    ...current,
                    displayName: event.target.value,
                  }))
                }
              />
              <input
                aria-label="İstisna nedeni"
                placeholder="İstisna nedeni"
                disabled={busy}
                value={exclusionDraft.reason}
                onChange={(event) =>
                  setExclusionDraft((current) => ({
                    ...current,
                    reason: event.target.value,
                  }))
                }
              />
              <button
                type="button"
                className="oc-secondary-button"
                disabled={busy || !exclusionDraft.phone.trim()}
                onClick={() => void addCrmExclusion()}
              >
                <ShieldCheck size={15} /> Numara ekle
              </button>
            </div>
            {crmExclusions.length > 0 && (
              <div className="oc-exclusion-list">
                {crmExclusions.map((exclusion) => (
                  <div key={exclusion.id}>
                    <span>
                      <strong>
                        {exclusion.display_name || exclusion.normalized_phone}
                      </strong>
                      <small>
                        {exclusion.normalized_phone} · {exclusion.reason}
                      </small>
                    </span>
                    <button
                      type="button"
                      className="oc-secondary-button"
                      disabled={busy}
                      onClick={() => void removeCrmExclusion(exclusion)}
                    >
                      Kaldır
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {reviewJobs.length > 0 && (
          <section
            className="oc-connections-panel oc-review-panel"
            aria-labelledby="oc-review-title"
          >
            <header>
              <div>
                <h2 id="oc-review-title">CRM incelemesi gereken kayıtlar</h2>
                <p>
                  Belirsiz eşleşmeler otomatik birleştirilmez. Doğru CRM kaydını
                  seçin veya teknik hatayı yeniden deneyin.
                </p>
              </div>
              <span>
                {reviewTotals.cases} vaka / {reviewTotals.jobs} mesaj işi
              </span>
            </header>
            <div className="oc-table" role="table">
              {reviewJobs.map((job) => {
                const input = reviewInputs[job.id] ?? {
                  entityType: "lead" as const,
                  externalId: "",
                };
                return (
                  <article
                    className="oc-table-item"
                    key={job.id}
                    role="rowgroup"
                  >
                    <div className="oc-table-row" role="row">
                      <div className="oc-table-cell channel" role="cell">
                        <strong>
                          {job.contact_name ||
                            job.normalized_phone ||
                            "Müşteri"}
                        </strong>
                        <span>{job.channel_name || "WhatsApp"}</span>
                        {(job.related_job_count ?? 1) > 1 && (
                          <small>{job.related_job_count} bağlı mesaj işi</small>
                        )}
                      </div>
                      <div className="oc-table-cell" role="cell">
                        <strong>{job.last_error || job.status}</strong>
                        <span>{safeDate(job.updated_at)}</span>
                      </div>
                      <div className="oc-table-cell" role="cell">
                        {job.status === "manual_review" ? (
                          <div className="oc-row-actions">
                            <select
                              aria-label="CRM kayıt türü"
                              disabled={busy}
                              value={input.entityType}
                              onChange={(event) =>
                                setReviewInputs((current) => ({
                                  ...current,
                                  [job.id]: {
                                    ...input,
                                    entityType: event.target.value as
                                      "lead" | "contact",
                                  },
                                }))
                              }
                            >
                              <option value="lead">Lead</option>
                              <option value="contact">Kişi</option>
                            </select>
                            <input
                              aria-label="Bitrix CRM kayıt ID"
                              inputMode="numeric"
                              placeholder="CRM ID"
                              disabled={busy}
                              value={input.externalId}
                              onChange={(event) =>
                                setReviewInputs((current) => ({
                                  ...current,
                                  [job.id]: {
                                    ...input,
                                    externalId: event.target.value.replace(
                                      /\D/g,
                                      "",
                                    ),
                                  },
                                }))
                              }
                            />
                            <button
                              type="button"
                              className="oc-secondary-button"
                              disabled={busy || !input.externalId}
                              onClick={() => void resolveReviewJob(job)}
                            >
                              Eşleştir
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            className="oc-secondary-button"
                            disabled={busy}
                            onClick={() => void retryReviewJob(job)}
                          >
                            <RotateCcw size={15} /> Yeniden dene
                          </button>
                        )}
                      </div>
                      <div className="oc-table-cell actions" role="cell">
                        <button
                          type="button"
                          className="oc-secondary-button"
                          disabled={busy}
                          onClick={() => void archiveReviewJob(job)}
                        >
                          Arşivle
                        </button>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        )}

        {notice && (
          <div className="oc-feedback success" role="status">
            <Check size={17} /> {notice}
          </div>
        )}
        {error && (
          <div className="oc-feedback error" role="alert">
            <CircleAlert size={17} />
            <span>{error}</span>
            <button type="button" onClick={() => void load()}>
              Yeniden dene
            </button>
          </div>
        )}

        <section className="oc-toolbar" aria-label="Bağlantı araçları">
          <label className="oc-search">
            <Search size={18} aria-hidden="true" />
            <span className="sr-only">Kanal veya açık hat ara</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Kanal, açık hat veya connector ara"
            />
            {query && (
              <button
                type="button"
                aria-label="Aramayı temizle"
                onClick={() => setQuery("")}
              >
                <X size={15} />
              </button>
            )}
          </label>
          <div className="oc-filter-wrap">
            <button
              type="button"
              className={`oc-toolbar-button ${
                filterOpen || activeFilterCount ? "active" : ""
              }`}
              aria-expanded={filterOpen}
              onClick={() => setFilterOpen((current) => !current)}
            >
              <Filter size={17} />
              Filtrele
              {activeFilterCount > 0 && <strong>{activeFilterCount}</strong>}
            </button>
            {filterOpen && (
              <div className="oc-filter-panel">
                <div className="oc-filter-heading">
                  <div>
                    <SlidersHorizontal size={17} />
                    <strong>Görünümü daralt</strong>
                  </div>
                  <button
                    type="button"
                    aria-label="Filtre panelini kapat"
                    onClick={() => setFilterOpen(false)}
                  >
                    <X size={16} />
                  </button>
                </div>
                <label>
                  Mesaj akışı
                  <select
                    value={directionFilter}
                    onChange={(event) =>
                      setDirectionFilter(
                        event.target.value as typeof directionFilter,
                      )
                    }
                  >
                    <option value="all">Tüm yönler</option>
                    <option value="both">Çift yönlü</option>
                    <option value="incoming">Yalnız gelen</option>
                    <option value="outgoing">Yalnız giden</option>
                    <option value="none">Akış kapalı</option>
                  </select>
                </label>
                <label>
                  CRM kayıt kuralı
                  <select
                    value={crmFilter}
                    onChange={(event) =>
                      setCrmFilter(event.target.value as typeof crmFilter)
                    }
                  >
                    <option value="all">Tüm kurallar</option>
                    <option value="disabled">Otomatik kayıt yok</option>
                    <option value="lead">Lead oluştur</option>
                    <option value="contact_and_deal">Kişi + Fırsat</option>
                  </select>
                </label>
                <button
                  type="button"
                  className="oc-clear-button"
                  onClick={clearFilters}
                >
                  <RotateCcw size={14} /> Filtreleri temizle
                </button>
              </div>
            )}
          </div>
        </section>

        <section className="oc-control-bar">
          <div className="oc-status-tabs" role="tablist" aria-label="Durum">
            {(
              [
                ["all", "Tümü"],
                ["active", "Aktif"],
                ["warning", "Sorunlu"],
                ["disabled", "Devre dışı"],
              ] as const
            ).map(([value, label]) => (
              <button
                type="button"
                role="tab"
                aria-selected={statusFilter === value}
                className={statusFilter === value ? "active" : ""}
                key={value}
                onClick={() => setStatusFilter(value)}
              >
                {label} <strong>{counts[value]}</strong>
              </button>
            ))}
          </div>
          <div className="oc-view-toggle" aria-label="Görünüm">
            <button
              type="button"
              className={view === "list" ? "active" : ""}
              aria-pressed={view === "list"}
              onClick={() => changeView("list")}
            >
              <List size={17} /> Liste
            </button>
            <button
              type="button"
              className={view === "kanban" ? "active" : ""}
              aria-pressed={view === "kanban"}
              onClick={() => changeView("kanban")}
            >
              <Grid2X2 size={16} /> Kanban
            </button>
          </div>
        </section>

        {loading ? (
          <section className="oc-loading" aria-label="Bağlantılar yükleniyor">
            <div />
            <div />
            <div />
          </section>
        ) : displayedItems.length === 0 ? (
          <section className="oc-empty-state">
            <span>
              <Columns3 size={24} />
            </span>
            <h2>Henüz Bitrix24 bağlantısı yok</h2>
            <p>
              Bir Bitrix24 portalı bağlayın; ardından kanal ve açık hat
              eşlemesini bu ekrandan yönetin.
            </p>
            <Link
              className="primary-button"
              href="/app/integrations/bitrix24/connect"
            >
              <Plus size={16} /> İlk bağlantıyı ekle
            </Link>
          </section>
        ) : filteredItems.length === 0 ? (
          <section className="oc-empty-state compact">
            <span>
              <Search size={22} />
            </span>
            <h2>Eşleşen bağlantı bulunamadı</h2>
            <p>Arama metnini veya seçili filtreleri değiştirin.</p>
            <button
              type="button"
              className="oc-secondary-button"
              onClick={clearFilters}
            >
              <RotateCcw size={15} /> Filtreleri temizle
            </button>
          </section>
        ) : view === "list" ? (
          <section className="oc-connections-panel">
            <header>
              <div>
                <h2>Bağlantılar</h2>
                <p>
                  BrixChat kanalı ile Bitrix24 açık hattı arasındaki canlı
                  eşlemeler
                </p>
              </div>
              <span>{filteredItems.length} bağlantı</span>
            </header>
            <div
              className="oc-table"
              role="table"
              aria-label="Open Channels bağlantıları"
            >
              <div className="oc-table-head" role="row">
                <span role="columnheader">WhatsApp kanalı</span>
                <span role="columnheader">Son kontrol</span>
                <span role="columnheader">Durum</span>
                <span role="columnheader">
                  <span className="sr-only">İşlemler</span>
                </span>
              </div>
              {filteredItems.map((item) => (
                <article
                  className="oc-table-item"
                  key={item.id}
                  role="rowgroup"
                >
                  <div className="oc-table-row" role="row">
                    <div
                      className="oc-table-cell channel"
                      role="cell"
                      data-label="WhatsApp kanalı"
                    >
                      <ChannelCell item={item} />
                    </div>
                    <div
                      className="oc-table-cell"
                      role="cell"
                      data-label="Son kontrol"
                    >
                      <strong>{safeDate(item.lastActivity)}</strong>
                    </div>
                    <div
                      className="oc-table-cell"
                      role="cell"
                      data-label="Durum"
                    >
                      <StatusBadge status={item.status} />
                    </div>
                    <div className="oc-table-cell actions" role="cell">
                      {renderConnectionActions(item)}
                    </div>
                  </div>
                </article>
              ))}
            </div>
            <footer className="oc-panel-footer">
              <span>
                {displayedItems.length} bağlantı · {counts.active} aktif · Son
                yenileme {safeDate(new Date().toISOString())}
              </span>
              <Link href="/app/integrations/bitrix24/logs">
                Sistem kayıtlarını görüntüle <ExternalLink size={14} />
              </Link>
            </footer>
          </section>
        ) : (
          <section className="oc-kanban" aria-label="Open Channels Kanban">
            {(["active", "warning", "disabled"] as const).map((status) => {
              const columnItems = filteredItems.filter(
                (item) => item.status === status,
              );
              return (
                <section className={`oc-kanban-column ${status}`} key={status}>
                  <header>
                    <div>
                      <span />
                      <strong>{statusMeta[status].label}</strong>
                    </div>
                    <em>{columnItems.length}</em>
                  </header>
                  <div className="oc-kanban-stack">
                    {columnItems.length === 0 ? (
                      <p>Bu durumda bağlantı yok.</p>
                    ) : (
                      columnItems.map((item) => (
                        <article className="oc-kanban-card" key={item.id}>
                          <ChannelCell item={item} />
                          <div className="oc-kanban-meta">
                            <span>
                              Son kontrol: {safeDate(item.lastActivity)}
                            </span>
                          </div>
                          <StatusBadge status={item.status} />
                          {renderConnectionActions(item)}
                        </article>
                      ))
                    )}
                  </div>
                </section>
              );
            })}
          </section>
        )}
      </div>

      {editingItem && (
        <div
          className="oc-drawer-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target && !busy)
              setEditingId(null);
          }}
        >
          <aside
            className="oc-drawer"
            role="dialog"
            aria-modal="true"
            aria-labelledby="oc-drawer-title"
          >
            <header className="oc-drawer-header">
              <div>
                <span>Open Channels bağlantısı</span>
                <h2 id="oc-drawer-title">{editingItem.connectionName}</h2>
                <p>Kanal, açık hat ve CRM davranışını yapılandırın.</p>
              </div>
              <button
                type="button"
                aria-label="Düzenleme panelini kapat"
                disabled={busy}
                onClick={() => setEditingId(null)}
              >
                <X size={19} />
              </button>
            </header>

            <div className="oc-drawer-body">
              <section className="oc-drawer-summary">
                <StatusBadge status={editingItem.status} />
                <span>
                  Connector <strong>{shorten(editingItem.connectorId)}</strong>
                </span>
              </section>

              <section className="oc-form-section">
                <header>
                  <span>
                    <Columns3 size={17} />
                  </span>
                  <div>
                    <h3>Bağlantı eşlemesi</h3>
                    <p>
                      Mesajların hangi kanal ve açık hat arasında akacağını
                      seçin.
                    </p>
                  </div>
                </header>
                <div className="oc-form-grid">
                  <label>
                    Çalışma modu
                    <select
                      value={mode}
                      onChange={(event) =>
                        setMode(
                          event.target.value as
                            "crm_context" | "open_channels" | "both",
                        )
                      }
                    >
                      <option value="crm_context">Yalnız CRM context</option>
                      <option value="open_channels">
                        Yalnız Open Channels
                      </option>
                      <option value="both">CRM + Open Channels</option>
                    </select>
                  </label>
                  <label>
                    BrixChat kanalı
                    <select value={settings.brixchatChannelId ?? ""} disabled>
                      <option value="">Kanal seçin</option>
                      {channels.map((channel) => (
                        <option key={channel.id} value={channel.id}>
                          {channel.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="full">
                    Bitrix24 açık hattı
                    <select
                      value={settings.lineId ?? ""}
                      onChange={(event) =>
                        setSettings((current) => ({
                          ...current,
                          lineId: event.target.value,
                        }))
                      }
                    >
                      <option value="">Açık hat seçin</option>
                      {editingItem.summary.lines.map((line) => (
                        <option
                          key={line.id}
                          value={line.id}
                          disabled={!line.active}
                        >
                          {line.name} {line.active ? "" : "(pasif)"}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              </section>

              <section className="oc-form-section">
                <header>
                  <span>
                    <ShieldCheck size={17} />
                  </span>
                  <div>
                    <h3>CRM kayıt kuralı</h3>
                    <p>
                      Yeni numaralar için güvenli kayıt davranışını belirleyin.
                    </p>
                  </div>
                </header>
                <div className="oc-form-grid">
                  <label className="full">
                    Bilinmeyen numarada oluştur
                    <select
                      value={settings.autoCrmMode ?? "disabled"}
                      onChange={(event) =>
                        setSettings((current) => ({
                          ...current,
                          autoCrmMode: event.target.value as
                            "disabled" | "lead" | "contact_and_deal",
                        }))
                      }
                    >
                      <option value="disabled">Otomatik kayıt yok</option>
                      <option value="lead">Lead</option>
                      <option value="contact_and_deal">Kişi + Fırsat</option>
                    </select>
                  </label>
                  {settings.autoCrmMode === "contact_and_deal" && (
                    <>
                      <label>
                        Pipeline
                        <select
                          value={settings.pipelineId ?? ""}
                          onChange={(event) => {
                            const nextPipeline = event.target.value;
                            const firstStage = pipelines.find(
                              (row) =>
                                row.pipeline_external_id === nextPipeline,
                            );
                            setSettings((current) => ({
                              ...current,
                              pipelineId: nextPipeline,
                              stageId: firstStage?.stage_external_id ?? "",
                            }));
                          }}
                        >
                          <option value="">Pipeline seçin</option>
                          {pipelineOptions.map(([pipelineId, name]) => (
                            <option key={pipelineId} value={pipelineId}>
                              {name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        İlk aşama
                        <select
                          value={settings.stageId ?? ""}
                          onChange={(event) =>
                            setSettings((current) => ({
                              ...current,
                              stageId: event.target.value,
                            }))
                          }
                        >
                          <option value="">Aşama seçin</option>
                          {stageOptions.map((stage) => (
                            <option
                              key={stage.stage_external_id}
                              value={stage.stage_external_id}
                            >
                              {stage.stage_name}
                            </option>
                          ))}
                        </select>
                      </label>
                    </>
                  )}
                </div>
                <div className="oc-safety-note">
                  <ShieldCheck size={16} />
                  <span>
                    Eşleşen kayıtlar yeniden kullanılır; belirsiz eşleşmeler
                    yeni kayıt oluşturmadan incelemeye bırakılır.
                  </span>
                </div>
              </section>

              <section className="oc-form-section">
                <header>
                  <span>
                    <ArrowLeftRight size={17} />
                  </span>
                  <div>
                    <h3>Mesaj ve senkronizasyon akışı</h3>
                    <p>
                      Connector yönlerini ve durum güncellemelerini yönetin.
                    </p>
                  </div>
                </header>
                <div className="oc-toggle-grid">
                  {flowToggles.map((toggle) => (
                    <label key={toggle.key}>
                      <span>
                        <strong>{toggle.label}</strong>
                        <small>{toggle.hint}</small>
                      </span>
                      <input
                        type="checkbox"
                        checked={Boolean(settings[toggle.key])}
                        onChange={(event) =>
                          setSettings((current) => ({
                            ...current,
                            [toggle.key]: event.target.checked,
                          }))
                        }
                      />
                    </label>
                  ))}
                </div>
              </section>

              {editingItem.summary.state?.last_error && (
                <div className="oc-feedback error" role="alert">
                  <CircleAlert size={17} />
                  <span>
                    Son connector hatası: {editingItem.summary.state.last_error}
                  </span>
                </div>
              )}
              {notice && (
                <div className="oc-feedback success" role="status">
                  <Check size={17} /> {notice}
                </div>
              )}
              {error && (
                <div className="oc-feedback error" role="alert">
                  <CircleAlert size={17} /> {error}
                </div>
              )}
            </div>

            <footer className="oc-drawer-footer">
              <div className="oc-lifecycle-actions">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void register()}
                >
                  Connector kaydet
                </button>
                <button
                  type="button"
                  disabled={busy || !editingItem.connectorId}
                  onClick={() => void health(editingItem)}
                >
                  <HeartPulse size={15} /> Sağlık testi
                </button>
                <button
                  type="button"
                  className="danger"
                  disabled={busy || !editingItem.binding}
                  onClick={() => void deactivate()}
                >
                  <Unplug size={15} /> Devre dışı bırak
                </button>
              </div>
              <div className="oc-save-actions">
                {!editingItem.binding && (
                  <button
                    type="button"
                    className="oc-secondary-button"
                    disabled={busy || !editingItem.connectorId}
                    onClick={() => void ensureChannel()}
                  >
                    Yeni Open Channel oluştur ve bağla
                  </button>
                )}
                <button
                  type="button"
                  className="oc-secondary-button"
                  disabled={busy}
                  onClick={() => setEditingId(null)}
                >
                  Vazgeç
                </button>
                <button
                  type="button"
                  className="oc-secondary-button"
                  disabled={busy}
                  onClick={() => void save()}
                >
                  Ayarları kaydet
                </button>
                <button
                  type="button"
                  className="primary-button"
                  disabled={
                    busy || !settings.lineId || !settings.brixchatChannelId
                  }
                  onClick={() => void activate()}
                >
                  {busy ? "İşleniyor…" : "Kaydet ve etkinleştir"}
                </button>
              </div>
            </footer>
          </aside>
        </div>
      )}
    </AppFrame>
  );
}
