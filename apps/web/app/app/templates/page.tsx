"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import {
  AlertTriangle,
  BookOpenText,
  ChevronRight,
  Copy,
  Eye,
  Filter,
  Languages,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Send,
  Trash2,
  X,
} from "lucide-react";
import { AppFrame } from "../../../components/app-frame";
import {
  WhatsAppTemplatePreview,
  type PreviewComponent,
} from "../../../components/whatsapp-template-preview";
import { apiJson } from "../../../lib/api";
import {
  normalizeTemplateName,
  readableLanguage,
  statusLabels,
  variablePositions,
} from "./template-center-utils";
import styles from "./templates.module.css";

type Channel = {
  id: string;
  name: string;
  provider: string;
  phoneNumber: string;
  phoneNumberId: string | null;
  businessAccountId: string | null;
  status: string;
};
type TemplateChannel = {
  id: string;
  name: string;
  phoneNumber: string;
  phoneNumberId: string | null;
};
type Template = {
  id: string;
  family_id: string | null;
  business_account_id: string | null;
  provider_template_id: string | null;
  name: string;
  normalized_name: string;
  language: string;
  category: string;
  status: string;
  quality_score: string | null;
  rejection_reason: string | null;
  body_text: string;
  components: PreviewComponent[];
  variable_count: number;
  usage_count: number;
  last_synced_at: string;
  version: number;
  channels: TemplateChannel[];
};
type Detail = Template & {
  header_type: string | null;
  header_text: string | null;
  footer_text: string | null;
  parameter_format: string;
  default_language: string | null;
  fallback_language: string | null;
  variables: Array<Record<string, unknown>>;
  dependencies: Array<Record<string, unknown>>;
  versions: Array<Record<string, unknown>>;
  recentUsage: Array<Record<string, unknown>>;
  auditHistory: Array<Record<string, unknown>>;
};
type Summary = {
  total: number;
  approved: number;
  pending: number;
  rejected: number;
  paused: number;
  disabled: number;
  draft: number;
};
type ListMeta = {
  page: number;
  limit: number;
  total: number;
  lastSync: Record<string, unknown> | null;
};
type Analytics = {
  sent: number;
  accepted: number;
  delivered: number;
  read: number;
  failed: number;
  replied: number;
  automationUsage: number;
  buttonClicks: number | null;
  estimatedCost: number | null;
  conversion: number | null;
};
type VariableDraft = {
  position: number;
  internalKey: string;
  exampleValue: string;
  defaultValue: string;
  missingPolicy: "block" | "default" | "manual";
};
type WizardDraft = {
  channelId: string;
  name: string;
  category: "UTILITY" | "MARKETING" | "AUTHENTICATION";
  language: string;
  internalLabel: string;
  folder: string;
  headerFormat: "NONE" | "TEXT" | "IMAGE" | "VIDEO" | "DOCUMENT" | "LOCATION";
  headerText: string;
  body: string;
  footer: string;
  buttonType: "NONE" | "QUICK_REPLY" | "URL" | "PHONE_NUMBER";
  buttonText: string;
  buttonValue: string;
};

const emptySummary: Summary = {
  total: 0,
  approved: 0,
  pending: 0,
  rejected: 0,
  paused: 0,
  disabled: 0,
  draft: 0,
};
const initialDraft: WizardDraft = {
  channelId: "",
  name: "",
  category: "UTILITY",
  language: "tr",
  internalLabel: "",
  folder: "",
  headerFormat: "NONE",
  headerText: "",
  body: "",
  footer: "",
  buttonType: "NONE",
  buttonText: "",
  buttonValue: "",
};

function componentsFromDraft(draft: WizardDraft): PreviewComponent[] {
  const result: PreviewComponent[] = [];
  if (draft.headerFormat !== "NONE")
    result.push({
      type: "HEADER",
      format: draft.headerFormat,
      ...(draft.headerText ? { text: draft.headerText } : {}),
    });
  result.push({ type: "BODY", text: draft.body });
  if (draft.footer.trim())
    result.push({ type: "FOOTER", text: draft.footer.trim() });
  if (draft.buttonType !== "NONE" && draft.buttonText.trim())
    result.push({
      type: "BUTTONS",
      buttons: [
        {
          type: draft.buttonType,
          text: draft.buttonText.trim(),
          ...(draft.buttonType === "URL" ? { url: draft.buttonValue } : {}),
          ...(draft.buttonType === "PHONE_NUMBER"
            ? { phone_number: draft.buttonValue }
            : {}),
        },
      ],
    });
  return result;
}
export default function TemplatesPage() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [items, setItems] = useState<Template[]>([]);
  const [summary, setSummary] = useState<Summary>(emptySummary);
  const [meta, setMeta] = useState<ListMeta | null>(null);
  const [selectedChannel, setSelectedChannel] = useState("");
  const [query, setQuery] = useState("");
  const [language, setLanguage] = useState("");
  const [category, setCategory] = useState("");
  const [status, setStatus] = useState("");
  const [quality, setQuality] = useState("");
  const [usage, setUsage] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [detail, setDetail] = useState<Detail | null>(null);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [wizardStep, setWizardStep] = useState(1);
  const [draft, setDraft] = useState<WizardDraft>(initialDraft);
  const [variables, setVariables] = useState<VariableDraft[]>([]);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    void apiJson<{ data: Channel[] }>("/api/v1/channels")
      .then((result) => {
        setChannels(result.data);
        setDraft((current) => ({
          ...current,
          channelId: current.channelId || result.data[0]?.id || "",
        }));
      })
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : "Kanallar yüklenemedi"),
      );
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    const params = new URLSearchParams();
    if (selectedChannel) params.set("channelId", selectedChannel);
    if (query) params.set("search", query);
    if (language) params.set("language", language);
    if (category) params.set("category", category);
    if (status) params.set("status", status);
    if (quality) params.set("quality", quality);
    if (usage) params.set("usage", usage);
    try {
      const [list, counts] = await Promise.all([
        apiJson<{ data: Template[]; meta: ListMeta }>(
          `/api/v1/templates?${params}`,
        ),
        apiJson<{ data: Summary }>(
          `/api/v1/templates/summary?${selectedChannel ? `channelId=${selectedChannel}` : ""}`,
        ),
      ]);
      setItems(list.data);
      setMeta(list.meta);
      setSummary(counts.data);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Şablonlar yüklenemedi");
    } finally {
      setLoading(false);
    }
  }, [category, language, quality, query, selectedChannel, status, usage]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 180);
    return () => window.clearTimeout(timer);
  }, [load]);

  const examples = useMemo(
    () =>
      Object.fromEntries(
        variables.map((variable) => [
          `body.${variable.position}`,
          variable.exampleValue,
        ]),
      ),
    [variables],
  );
  const previewComponents = useMemo(() => componentsFromDraft(draft), [draft]);
  const languages = useMemo(
    () => [...new Set(items.map((item) => item.language))].sort(),
    [items],
  );

  async function openDetail(id: string) {
    setDetailLoading(true);
    setError("");
    try {
      const [result, metrics] = await Promise.all([
        apiJson<{ data: Detail }>(`/api/v1/templates/${id}`),
        apiJson<{ data: Analytics }>(`/api/v1/templates/${id}/analytics`),
      ]);
      setDetail(result.data);
      setAnalytics(metrics.data);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Ayrıntı yüklenemedi");
    } finally {
      setDetailLoading(false);
    }
  }

  async function sync() {
    if (!selectedChannel) {
      setError("Senkronizasyon için bir WABA/kanal seçin.");
      return;
    }
    setSyncing(true);
    setError("");
    try {
      const result = await apiJson<{
        data: {
          created?: number;
          updated?: number;
          archived?: number;
          status: string;
        };
      }>(`/api/v1/channels/${selectedChannel}/templates/sync`, {
        method: "POST",
        headers: { "x-idempotency-key": crypto.randomUUID() },
      });
      setNotice(
        `Senkronizasyon tamamlandı: ${result.data.created ?? 0} yeni, ${result.data.updated ?? 0} güncel, ${result.data.archived ?? 0} arşiv.`,
      );
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Senkronizasyon başarısız");
    } finally {
      setSyncing(false);
    }
  }

  async function saveDraft(submitToMeta: boolean) {
    if (!draft.channelId || !normalizeTemplateName(draft.name) || !draft.body.trim()) {
      setError("Kanal, şablon adı ve mesaj gövdesi zorunludur.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const payload = {
        channelId: draft.channelId,
        name: draft.name,
        language: draft.language,
        category: draft.category,
        components: previewComponents,
        parameterFormat: "positional",
        internalLabel: draft.internalLabel || null,
        folder: draft.folder || null,
        variables: variables.map((variable) => ({
          component: "body",
          position: variable.position,
          internalKey: variable.internalKey,
          exampleValue: variable.exampleValue || undefined,
          defaultValue: variable.defaultValue || undefined,
          required: true,
          missingPolicy: variable.missingPolicy,
          formatter: "text",
        })),
      };
      const saved = await apiJson<{ data: { id: string } }>(
        editingId ? `/api/v1/templates/${editingId}` : "/api/v1/templates",
        {
          method: editingId ? "PATCH" : "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      if (submitToMeta)
        await apiJson(`/api/v1/templates/${saved.data.id}/submit`, {
          method: "POST",
        });
      setNotice(
        submitToMeta
          ? "Şablon Meta onayına gönderildi."
          : editingId
            ? "Şablon taslağı güncellendi."
            : "Şablon taslak olarak kaydedildi.",
      );
      setWizardOpen(false);
      setEditingId(null);
      setWizardStep(1);
      setDraft({ ...initialDraft, channelId: draft.channelId });
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Şablon kaydedilemedi");
    } finally {
      setSaving(false);
    }
  }

  async function removeTemplate() {
    if (!detail) return;
    if (detail.dependencies.length) {
      setError("Bağlı otomasyon veya kampanya kaldırılmadan şablon silinemez.");
      return;
    }
    if (!window.confirm(`${detail.name} şablonunu Meta ve Brixchat24'ten silmek istediğinize emin misiniz?`))
      return;
    setSaving(true);
    try {
      await apiJson(`/api/v1/templates/${detail.id}`, { method: "DELETE" });
      setDetail(null);
      setNotice("Şablon güvenli biçimde silindi.");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Şablon silinemedi");
    } finally {
      setSaving(false);
    }
  }

  function duplicateTemplate() {
    if (!detail) return;
    setDraft({
      ...initialDraft,
      channelId: detail.channels[0]?.id ?? "",
      name: `${detail.normalized_name}_copy`,
      category: detail.category as WizardDraft["category"],
      language: detail.language,
      body: detail.body_text,
      footer: detail.footer_text ?? "",
      headerFormat: detail.header_type
        ? (detail.header_type.toUpperCase() as WizardDraft["headerFormat"])
        : "NONE",
      headerText: detail.header_text ?? "",
    });
    setVariables(
      detail.variables.map((variable) => ({
        position: Number(variable.position),
        internalKey: String(
          variable.internal_key ?? variable.variable_name ?? "",
        ),
        exampleValue: String(variable.example_value ?? ""),
        defaultValue: String(variable.default_value ?? ""),
        missingPolicy: String(
          variable.missing_policy ?? "block",
        ) as VariableDraft["missingPolicy"],
      })),
    );
    setDetail(null);
    setEditingId(null);
    setWizardStep(1);
    setWizardOpen(true);
  }

  function editTemplate() {
    if (!detail || !["draft", "rejected"].includes(detail.status)) return;
    const buttonComponent = detail.components.find(
      (component) => component.type === "BUTTONS",
    );
    const firstButton = buttonComponent?.buttons?.[0];
    setDraft({
      ...initialDraft,
      channelId: detail.channels[0]?.id ?? "",
      name: detail.normalized_name,
      category: detail.category as WizardDraft["category"],
      language: detail.language,
      headerFormat: detail.header_type
        ? (detail.header_type.toUpperCase() as WizardDraft["headerFormat"])
        : "NONE",
      headerText: detail.header_text ?? "",
      body: detail.body_text,
      footer: detail.footer_text ?? "",
      buttonType:
        (firstButton?.type as WizardDraft["buttonType"] | undefined) ?? "NONE",
      buttonText: String(firstButton?.text ?? ""),
      buttonValue: String(firstButton?.url ?? firstButton?.phone_number ?? ""),
    });
    setVariables(
      detail.variables.map((variable) => ({
        position: Number(variable.position),
        internalKey: String(
          variable.internal_key ?? variable.variable_name ?? "",
        ),
        exampleValue: String(variable.example_value ?? ""),
        defaultValue: String(variable.default_value ?? ""),
        missingPolicy: String(
          variable.missing_policy ?? "block",
        ) as VariableDraft["missingPolicy"],
      })),
    );
    setEditingId(detail.id);
    setDetail(null);
    setWizardStep(1);
    setWizardOpen(true);
  }

  const filtersActive = Boolean(
    query || language || category || status || quality || usage,
  );
  const selectedChannelData = channels.find(
    (channel) => channel.id === selectedChannel,
  );

  function updateBody(body: string) {
    setDraft((current) => ({ ...current, body }));
    setVariables((current) =>
      variablePositions(body).map(
        (position) =>
          current.find((item) => item.position === position) ?? {
            position,
            internalKey:
              position === 1 ? "contact.first_name" : "appointment.date",
            exampleValue: position === 1 ? "Ayşe" : "28 Temmuz 2026",
            defaultValue: "",
            missingPolicy: "block",
          },
      ),
    );
  }

  return (
    <AppFrame
      title="WhatsApp Şablon Yönetim Merkezi"
      subtitle="Meta Cloud API şablonlarını WABA bazında oluşturun, senkronize edin, yönetin ve güvenli biçimde kullanın."
    >
      <div className={styles.toolbar}>
        <div className={styles.primaryActions}>
          <button
            className={styles.primary}
            onClick={() => {
              setEditingId(null);
              setDraft({
                ...initialDraft,
                channelId: selectedChannel || draft.channelId,
              });
              setVariables([]);
              setWizardStep(1);
              setWizardOpen(true);
            }}
            type="button"
          >
            <Plus size={17} /> Yeni şablon
          </button>
          <button
            onClick={() => void sync()}
            disabled={!selectedChannel || syncing}
            type="button"
          >
            <RefreshCw className={syncing ? styles.spin : ""} size={17} />
            Meta&apos;dan senkronize et
          </button>
        </div>
        <label>
          <span>WABA / kanal</span>
          <select
            value={selectedChannel}
            onChange={(event) => setSelectedChannel(event.target.value)}
          >
            <option value="">Tüm erişilebilir kanallar</option>
            {channels.map((channel) => (
              <option key={channel.id} value={channel.id}>
                {channel.name} · {channel.phoneNumber}
              </option>
            ))}
          </select>
        </label>
        <div className={styles.syncState}>
          <small>Son senkronizasyon</small>
          <strong>
            {meta?.lastSync?.started_at
              ? new Date(String(meta.lastSync.started_at)).toLocaleString("tr-TR")
              : "Henüz yok"}
          </strong>
          {selectedChannelData?.businessAccountId ? (
            <span>WABA {selectedChannelData.businessAccountId}</span>
          ) : null}
        </div>
      </div>

      {error ? (
        <div className={styles.error} role="alert">
          <AlertTriangle size={18} /> {error}
        </div>
      ) : null}
      {notice ? (
        <div className={styles.notice} role="status">
          {notice}
          <button aria-label="Bildirimi kapat" onClick={() => setNotice("")}>
            <X size={15} />
          </button>
        </div>
      ) : null}

      <section className={styles.summary} aria-label="Şablon özeti">
        {(
          [
            ["Toplam", summary.total, "total"],
            ["Onaylandı", summary.approved, "approved"],
            ["İncelemede", summary.pending, "pending"],
            ["Reddedildi", summary.rejected, "rejected"],
            ["Duraklatıldı", summary.paused, "paused"],
            ["Devre dışı", summary.disabled, "disabled"],
            ["Taslak", summary.draft, "draft"],
          ] as const
        ).map(([label, value, key]) => (
          <button
            type="button"
            key={key}
            onClick={() => setStatus(key === "total" ? "" : key)}
            className={status === key ? styles.activeCard : ""}
          >
            <span>{label}</span>
            <strong>{value}</strong>
          </button>
        ))}
      </section>

      <section className={styles.filters}>
        <label className={styles.search}>
          <Search size={17} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Şablon adı veya içerikte ara"
          />
        </label>
        <Filter size={17} aria-hidden="true" />
        <select aria-label="Dil filtresi" value={language} onChange={(event) => setLanguage(event.target.value)}>
          <option value="">Tüm diller</option>
          {languages.map((item) => (
            <option value={item} key={item}>
              {readableLanguage(item)}
            </option>
          ))}
        </select>
        <select aria-label="Kategori filtresi" value={category} onChange={(event) => setCategory(event.target.value)}>
          <option value="">Tüm kategoriler</option>
          <option value="UTILITY">Utility</option>
          <option value="MARKETING">Marketing</option>
          <option value="AUTHENTICATION">Authentication</option>
        </select>
        <select aria-label="Şablon durumu filtresi" value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="">Tüm durumlar</option>
          {Object.entries(statusLabels).map(([value, label]) => (
            <option value={value} key={value}>
              {label}
            </option>
          ))}
        </select>
        <select aria-label="Kalite filtresi" value={quality} onChange={(event) => setQuality(event.target.value)}>
          <option value="">Tüm kalite durumları</option>
          <option value="GREEN">Yüksek</option>
          <option value="YELLOW">Orta</option>
          <option value="RED">Düşük</option>
        </select>
        <select aria-label="Kullanım filtresi" value={usage} onChange={(event) => setUsage(event.target.value)}>
          <option value="">Tüm kullanımlar</option>
          <option value="used">Kullanılan</option>
          <option value="unused">Kullanılmayan</option>
        </select>
      </section>

      {loading ? (
        <div className={styles.loading} aria-live="polite">
          <LoaderCircle className={styles.spin} /> Şablonlar yükleniyor…
        </div>
      ) : items.length === 0 ? (
        <div className={styles.empty}>
          <BookOpenText />
          <h2>{filtersActive ? "Filtre sonucu bulunamadı" : "Henüz şablon yok"}</h2>
          <p>
            {filtersActive
              ? "Filtreleri temizleyin veya başka bir WABA seçin."
              : "Yeni bir taslak oluşturun ya da Meta'dan senkronize edin."}
          </p>
        </div>
      ) : (
        <div className={styles.tableWrap}>
          <table>
            <caption className="sr-only">WhatsApp şablonları</caption>
            <thead>
              <tr>
                <th>Şablon</th>
                <th>WABA / numaralar</th>
                <th>Dil</th>
                <th>Kategori</th>
                <th>Durum</th>
                <th>Kalite</th>
                <th>Değişken</th>
                <th>Kullanım</th>
                <th>Son sync</th>
                <th aria-label="İşlemler" />
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} onClick={() => void openDetail(item.id)}>
                  <td>
                    <strong>{item.name}</strong>
                    <small>{item.body_text}</small>
                  </td>
                  <td>
                    <strong>{item.channels[0]?.name ?? "Kanal yok"}</strong>
                    <small>
                      {item.channels.map((channel) => channel.phoneNumber).join(", ")}
                    </small>
                  </td>
                  <td>{readableLanguage(item.language)}</td>
                  <td>{item.category}</td>
                  <td>
                    <span className={`${styles.pill} ${styles[item.status] ?? ""}`}>
                      {statusLabels[item.status] ?? item.status}
                    </span>
                  </td>
                  <td>{item.quality_score ?? "Veri yok"}</td>
                  <td>{item.variable_count}</td>
                  <td>{item.usage_count}</td>
                  <td>{new Date(item.last_synced_at).toLocaleString("tr-TR")}</td>
                  <td>
                    <button
                      type="button"
                      aria-label={`${item.name} ayrıntısını aç`}
                      onClick={(event) => {
                        event.stopPropagation();
                        void openDetail(item.id);
                      }}
                    >
                      <ChevronRight size={17} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <footer>
            {meta?.total ?? items.length} kayıttan {items.length} tanesi gösteriliyor
          </footer>
        </div>
      )}

      {(detail || detailLoading) && (
        <div className={styles.backdrop} onMouseDown={() => setDetail(null)}>
          <aside
            className={styles.drawer}
            onMouseDown={(event) => event.stopPropagation()}
            aria-label="Şablon ayrıntısı"
          >
            {detailLoading && !detail ? (
              <div className={styles.loading}>
                <LoaderCircle className={styles.spin} /> Ayrıntı yükleniyor…
              </div>
            ) : detail ? (
              <>
                <header>
                  <div>
                    <small>{detail.provider_template_id || "Yerel taslak"}</small>
                    <h2>{detail.name}</h2>
                    <span className={`${styles.pill} ${styles[detail.status] ?? ""}`}>
                      {statusLabels[detail.status] ?? detail.status}
                    </span>
                  </div>
                  <button aria-label="Ayrıntıyı kapat" onClick={() => setDetail(null)}>
                    <X />
                  </button>
                </header>
                <div className={styles.drawerGrid}>
                  <WhatsAppTemplatePreview
                    components={detail.components ?? [
                      { type: "BODY", text: detail.body_text },
                    ]}
                    examples={Object.fromEntries(
                      detail.variables.map((variable) => [
                        `${variable.component}.${variable.position}`,
                        String(variable.example_value ?? ""),
                      ]),
                    )}
                    language={detail.language}
                  />
                  <div className={styles.facts}>
                    <dl>
                      <div><dt>WABA</dt><dd>{detail.business_account_id ?? "Yok"}</dd></div>
                      <div><dt>Numaralar</dt><dd>{detail.channels.map((item) => item.phoneNumber).join(", ")}</dd></div>
                      <div><dt>Dil</dt><dd>{readableLanguage(detail.language)}</dd></div>
                      <div><dt>Kategori</dt><dd>{detail.category}</dd></div>
                      <div><dt>Kalite</dt><dd>{detail.quality_score ?? "Veri bulunmuyor"}</dd></div>
                      <div><dt>Sürüm</dt><dd>{detail.version}</dd></div>
                      <div><dt>Fallback</dt><dd>{detail.fallback_language ?? "Tanımlı değil"}</dd></div>
                    </dl>
                    {detail.rejection_reason ? (
                      <div className={styles.rejection}>
                        <AlertTriangle size={16} /> {detail.rejection_reason}
                      </div>
                    ) : null}
                    <h3>Değişkenler</h3>
                    {detail.variables.length ? (
                      <ul>
                        {detail.variables.map((variable, index) => (
                          <li key={index}>
                            <code>{String(variable.internal_key ?? variable.variable_name)}</code>
                            <span>{String(variable.missing_policy ?? "block")}</span>
                          </li>
                        ))}
                      </ul>
                    ) : <p>Bu şablonda değişken yok.</p>}
                    <h3>Bağımlılıklar</h3>
                    {detail.dependencies.length ? (
                      <ul>
                        {detail.dependencies.map((dependency, index) => (
                          <li key={index}>
                            {String(dependency.dependency_type)} · {String(dependency.dependency_label ?? dependency.dependency_id)}
                          </li>
                        ))}
                      </ul>
                    ) : <p>Bağlı otomasyon veya kampanya yok.</p>}
                    <h3>Performans</h3>
                    {analytics ? (
                      <dl>
                        <div><dt>Gönderildi</dt><dd>{analytics.sent}</dd></div>
                        <div><dt>Teslim edildi</dt><dd>{analytics.delivered}</dd></div>
                        <div><dt>Okundu</dt><dd>{analytics.read}</dd></div>
                        <div><dt>Cevaplandı</dt><dd>{analytics.replied}</dd></div>
                        <div><dt>Başarısız</dt><dd>{analytics.failed}</dd></div>
                        <div><dt>Tahmini maliyet</dt><dd>{analytics.estimatedCost ?? "Ölçülemiyor"}</dd></div>
                      </dl>
                    ) : <p>Analitik verisi bulunmuyor.</p>}
                  </div>
                </div>
                <footer className={styles.drawerActions}>
                  {["draft", "rejected"].includes(detail.status) ? (
                    <button type="button" onClick={editTemplate}>
                      <Pencil size={16} /> Düzenle
                    </button>
                  ) : null}
                  <button type="button" onClick={duplicateTemplate}>
                    <Copy size={16} /> Çoğalt
                  </button>
                  <button type="button" onClick={duplicateTemplate}>
                    <Languages size={16} /> Dil varyantı
                  </button>
                  <button
                    className={styles.danger}
                    type="button"
                    onClick={() => void removeTemplate()}
                    disabled={saving || detail.dependencies.length > 0}
                  >
                    <Trash2 size={16} /> Sil
                  </button>
                </footer>
              </>
            ) : null}
          </aside>
        </div>
      )}

      {wizardOpen && (
        <div className={styles.backdrop}>
          <section
            className={styles.wizard}
            aria-label={
              editingId
                ? "Şablon düzenleme sihirbazı"
                : "Yeni şablon sihirbazı"
            }
          >
            <header>
              <div>
                <small>Adım {wizardStep} / 4</small>
                <h2>
                  {wizardStep === 1 && "Temel bilgiler"}
                  {wizardStep === 2 && "İçerik oluşturucu"}
                  {wizardStep === 3 && "Değişkenler ve örnekler"}
                  {wizardStep === 4 && "Önizleme ve gönderim"}
                </h2>
              </div>
              <button
                aria-label="Sihirbazı kapat"
                onClick={() => {
                  setWizardOpen(false);
                  setEditingId(null);
                }}
              >
                <X />
              </button>
            </header>
            <div className={styles.steps}>
              {[1, 2, 3, 4].map((step) => (
                <span key={step} className={step <= wizardStep ? styles.done : ""} />
              ))}
            </div>
            <div className={styles.wizardBody}>
              <div className={styles.formPane}>
                {wizardStep === 1 && (
                  <div className={styles.formGrid}>
                    <label><span>WABA / kanal</span><select value={draft.channelId} onChange={(event) => setDraft({ ...draft, channelId: event.target.value })}><option value="">Seçin</option>{channels.map((channel) => <option key={channel.id} value={channel.id}>{channel.name} · {channel.phoneNumber}</option>)}</select></label>
                    <label><span>Şablon adı</span><input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="randevu_hatirlatma" /><small>Meta adı: {normalizeTemplateName(draft.name) || "—"}</small></label>
                    <label><span>Kategori</span><select value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value as WizardDraft["category"] })}><option value="UTILITY">Utility</option><option value="MARKETING">Marketing</option><option value="AUTHENTICATION">Authentication</option></select></label>
                    <label><span>Dil</span><select value={draft.language} onChange={(event) => setDraft({ ...draft, language: event.target.value })}><option value="tr">Türkçe</option><option value="en_US">İngilizce (ABD)</option><option value="de">Almanca</option><option value="ar">Arapça</option></select></label>
                    <label><span>Dahili etiket</span><input value={draft.internalLabel} onChange={(event) => setDraft({ ...draft, internalLabel: event.target.value })} /></label>
                    <label><span>Klasör</span><input value={draft.folder} onChange={(event) => setDraft({ ...draft, folder: event.target.value })} /></label>
                  </div>
                )}
                {wizardStep === 2 && (
                  <div className={styles.formGrid}>
                    <label><span>Başlık türü</span><select value={draft.headerFormat} onChange={(event) => setDraft({ ...draft, headerFormat: event.target.value as WizardDraft["headerFormat"], headerText: event.target.value === "TEXT" ? draft.headerText : "" })}><option value="NONE">Başlık yok</option><option value="TEXT">Metin</option><option value="IMAGE">Görsel</option><option value="VIDEO">Video</option><option value="DOCUMENT">Belge</option><option value="LOCATION">Konum</option></select></label>
                    {draft.headerFormat === "TEXT" && <label><span>Başlık metni · {draft.headerText.length}/60</span><input maxLength={60} value={draft.headerText} onChange={(event) => setDraft({ ...draft, headerText: event.target.value })} /></label>}
                    <label className={styles.full}><span>Mesaj gövdesi · {draft.body.length}/1024</span><textarea maxLength={1024} rows={8} value={draft.body} onChange={(event) => updateBody(event.target.value)} placeholder={"Merhaba {{1}}, randevunuz {{2}} tarihinde."} /><small>Değişkenleri sıralı olarak {"{{1}}"}, {"{{2}}"} biçiminde ekleyin.</small></label>
                    <label><span>Alt bilgi · {draft.footer.length}/60</span><input maxLength={60} value={draft.footer} onChange={(event) => setDraft({ ...draft, footer: event.target.value })} /></label>
                    <label><span>Buton türü</span><select value={draft.buttonType} onChange={(event) => setDraft({ ...draft, buttonType: event.target.value as WizardDraft["buttonType"] })}><option value="NONE">Buton yok</option><option value="QUICK_REPLY">Hızlı yanıt</option><option value="URL">URL</option><option value="PHONE_NUMBER">Telefon</option></select></label>
                    {draft.buttonType !== "NONE" && <><label><span>Buton metni</span><input value={draft.buttonText} onChange={(event) => setDraft({ ...draft, buttonText: event.target.value })} /></label>{draft.buttonType !== "QUICK_REPLY" && <label><span>{draft.buttonType === "URL" ? "URL" : "Telefon numarası"}</span><input value={draft.buttonValue} onChange={(event) => setDraft({ ...draft, buttonValue: event.target.value })} /></label>}</>}
                  </div>
                )}
                {wizardStep === 3 && (
                  <div className={styles.variables}>
                    {variables.length === 0 ? <p>Mesaj gövdesinde değişken bulunmuyor.</p> : variables.map((variable, index) => (
                      <fieldset key={variable.position}>
                        <legend>{"{{"}{variable.position}{"}}"}</legend>
                        <label><span>Dahili değişken</span><input value={variable.internalKey} onChange={(event) => setVariables((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, internalKey: event.target.value } : item))} placeholder="contact.first_name" /></label>
                        <label><span>Örnek değer</span><input value={variable.exampleValue} onChange={(event) => setVariables((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, exampleValue: event.target.value } : item))} /></label>
                        <label><span>Eksik değer politikası</span><select value={variable.missingPolicy} onChange={(event) => setVariables((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, missingPolicy: event.target.value as VariableDraft["missingPolicy"] } : item))}><option value="block">Gönderimi engelle</option><option value="default">Varsayılanı kullan</option><option value="manual">Temsilciden iste</option></select></label>
                        {variable.missingPolicy === "default" && <label><span>Varsayılan değer</span><input value={variable.defaultValue} onChange={(event) => setVariables((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, defaultValue: event.target.value } : item))} /></label>}
                      </fieldset>
                    ))}
                  </div>
                )}
                {wizardStep === 4 && (
                  <div className={styles.review}>
                    <h3>Gönderim öncesi doğrulama</h3>
                    <ul>
                      <li className={draft.channelId ? styles.valid : styles.invalid}>WABA / kanal seçimi</li>
                      <li className={normalizeTemplateName(draft.name) ? styles.valid : styles.invalid}>Normalize edilmiş Meta adı</li>
                      <li className={draft.body.trim() ? styles.valid : styles.invalid}>Mesaj gövdesi</li>
                      <li className={variables.every((item) => item.internalKey && item.exampleValue) ? styles.valid : styles.invalid}>Değişken eşlemeleri ve örnekler</li>
                    </ul>
                    <details><summary>Provider payload önizlemesi</summary><pre>{JSON.stringify({ name: normalizeTemplateName(draft.name), language: draft.language, category: draft.category, components: previewComponents }, null, 2)}</pre></details>
                  </div>
                )}
              </div>
              <WhatsAppTemplatePreview components={previewComponents} examples={examples} language={draft.language} />
            </div>
            <footer className={styles.wizardActions}>
              <button type="button" onClick={() => setWizardStep((step) => Math.max(1, step - 1))} disabled={wizardStep === 1}>Geri</button>
              {wizardStep < 4 ? (
                <button className={styles.primary} type="button" onClick={() => setWizardStep((step) => Math.min(4, step + 1))}>Devam</button>
              ) : (
                <>
                  <button type="button" onClick={() => void saveDraft(false)} disabled={saving}><Eye size={16} /> Taslak kaydet</button>
                  <button className={styles.primary} type="button" onClick={() => void saveDraft(true)} disabled={saving}><Send size={16} /> Meta onayına gönder</button>
                </>
              )}
            </footer>
          </section>
        </div>
      )}
    </AppFrame>
  );
}
