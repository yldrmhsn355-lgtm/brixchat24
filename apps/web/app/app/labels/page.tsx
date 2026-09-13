"use client";

import {
  Archive,
  BarChart3,
  Copy,
  Edit3,
  GitMerge,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  Tag,
  Trash2,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import { AppFrame } from "../../../components/app-frame";
import { apiJson } from "../../../lib/api";
import {
  canCreateWorkspaceLabels,
  canManageLabels,
  labelTextColor,
} from "../../../lib/labels";

type LabelScope = "workspace" | "team" | "channel";
type LabelStatus = "active" | "archived";
type Label = {
  id: string;
  name: string;
  description: string | null;
  color: string;
  icon: string | null;
  category_id: string | null;
  category_name: string | null;
  selection_mode: "single" | "multiple" | null;
  scope: LabelScope;
  team_id: string | null;
  team_name: string | null;
  channel_id: string | null;
  channel_name: string | null;
  status: LabelStatus;
  usage_count: number;
  automation_usage_count: number;
  last_used_at: string | null;
  updated_at: string;
  updated_by_name: string | null;
  version: number;
  is_protected: boolean;
  favorite: boolean;
};
type Category = {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  selection_mode: "single" | "multiple";
  label_count: number;
};
type NamedOption = { id: string; name: string };
type Summary = {
  total: number;
  active: number;
  archived: number;
  unused: number;
  workspace: number;
  team: number;
  channel: number;
  automated: number;
};
type Dependencies = {
  conversations: number;
  automations: number;
  mappings: number;
};
type Editor = {
  id: string | null;
  version: number;
  name: string;
  description: string;
  color: string;
  icon: string;
  categoryId: string;
  scope: LabelScope;
  teamId: string;
  channelId: string;
  sortOrder: number;
  isProtected: boolean;
};

const EMPTY_SUMMARY: Summary = {
  total: 0,
  active: 0,
  archived: 0,
  unused: 0,
  workspace: 0,
  team: 0,
  channel: 0,
  automated: 0,
};
const COLORS = [
  "#4f46e5",
  "#7c3aed",
  "#db2777",
  "#dc2626",
  "#ea580c",
  "#ca8a04",
  "#16a34a",
  "#0891b2",
  "#2563eb",
  "#475569",
];

function message(reason: unknown, fallback: string) {
  return reason instanceof Error ? reason.message : fallback;
}

function localDate(value: string | null) {
  if (!value) return "Henüz yok";
  return new Intl.DateTimeFormat("tr-TR", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export default function LabelsPage() {
  const [labels, setLabels] = useState<Label[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [teams, setTeams] = useState<NamedOption[]>([]);
  const [channels, setChannels] = useState<NamedOption[]>([]);
  const [summary, setSummary] = useState(EMPTY_SUMMARY);
  const [role, setRole] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [search, setSearch] = useState("");
  const [scope, setScope] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [status, setStatus] = useState<LabelStatus>("active");
  const [usage, setUsage] = useState("");
  const [sort, setSort] = useState("sort_order");
  const [editor, setEditor] = useState<Editor | null>(null);
  const [detail, setDetail] = useState<Label | null>(null);
  const [dependencies, setDependencies] = useState<Dependencies | null>(null);
  const [categoryModal, setCategoryModal] = useState(false);
  const canManage = canManageLabels(role);

  const query = useMemo(() => {
    const params = new URLSearchParams({ status, sort, limit: "100" });
    if (search.trim()) params.set("search", search.trim());
    if (scope) params.set("scope", scope);
    if (categoryId) params.set("categoryId", categoryId);
    if (usage) params.set("usage", usage);
    return params.toString();
  }, [categoryId, scope, search, sort, status, usage]);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [labelResult, categoryResult] = await Promise.all([
        apiJson<{ data: Label[]; summary: Summary }>(`/api/v1/labels?${query}`),
        apiJson<{ data: Category[] }>("/api/v1/label-categories"),
      ]);
      setLabels(labelResult.data ?? []);
      setSummary(labelResult.summary ?? EMPTY_SUMMARY);
      setCategories(categoryResult.data ?? []);
    } catch (reason) {
      setError(message(reason, "Etiket yönetim merkezi yüklenemedi."));
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  useEffect(() => {
    void apiJson<{ data: { role: string } }>("/api/v1/auth/me")
      .then((result) => setRole(result.data.role))
      .catch(() => setRole(null));
    void apiJson<{ data: NamedOption[] }>("/api/v1/teams")
      .then((result) => setTeams(result.data ?? []))
      .catch(() => setTeams([]));
    void apiJson<{ data: NamedOption[] }>("/api/v1/channels")
      .then((result) => setChannels(result.data ?? []))
      .catch(() => setChannels([]));
  }, []);

  function openCreate() {
    const workspaceAllowed = canCreateWorkspaceLabels(role);
    setEditor({
      id: null,
      version: 1,
      name: "",
      description: "",
      color: "#4f46e5",
      icon: "",
      categoryId: "",
      scope: workspaceAllowed ? "workspace" : "team",
      teamId: "",
      channelId: "",
      sortOrder: 0,
      isProtected: false,
    });
  }

  function openEdit(label: Label) {
    setEditor({
      id: label.id,
      version: label.version,
      name: label.name,
      description: label.description ?? "",
      color: label.color,
      icon: label.icon ?? "",
      categoryId: label.category_id ?? "",
      scope: label.scope,
      teamId: label.team_id ?? "",
      channelId: label.channel_id ?? "",
      sortOrder: 0,
      isProtected: label.is_protected,
    });
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editor) return;
    setSaving(true);
    setError("");
    const payload = {
      name: editor.name,
      description: editor.description || null,
      color: editor.color,
      icon: editor.icon || null,
      categoryId: editor.categoryId || null,
      scope: editor.scope,
      teamId: editor.scope === "team" ? editor.teamId || null : null,
      channelId: editor.scope === "channel" ? editor.channelId || null : null,
      sortOrder: editor.sortOrder,
      isProtected: editor.isProtected,
      ...(editor.id ? { version: editor.version } : {}),
    };
    try {
      await apiJson(
        editor.id ? `/api/v1/labels/${editor.id}` : "/api/v1/labels",
        {
          method: editor.id ? "PATCH" : "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      setEditor(null);
      setNotice(editor.id ? "Etiket güncellendi." : "Etiket oluşturuldu.");
      await load();
    } catch (reason) {
      setError(message(reason, "Etiket kaydedilemedi."));
    } finally {
      setSaving(false);
    }
  }

  async function action(
    label: Label,
    operation: "archive" | "restore" | "duplicate",
  ) {
    setError("");
    try {
      await apiJson(`/api/v1/labels/${label.id}/${operation}`, {
        method: "POST",
      });
      setNotice(
        operation === "archive"
          ? "Etiket arşivlendi."
          : operation === "restore"
            ? "Etiket geri yüklendi."
            : "Etiket kopyalandı.",
      );
      await load();
    } catch (reason) {
      setError(message(reason, "İşlem tamamlanamadı."));
    }
  }

  async function openDetail(label: Label) {
    setDetail(label);
    setDependencies(null);
    try {
      const result = await apiJson<{ data: Dependencies }>(
        `/api/v1/labels/${label.id}/dependencies`,
      );
      setDependencies(result.data);
    } catch {
      setDependencies({
        conversations: label.usage_count,
        automations: 0,
        mappings: 0,
      });
    }
  }

  async function remove(label: Label) {
    const dependencyResult = await apiJson<{ data: Dependencies }>(
      `/api/v1/labels/${label.id}/dependencies`,
    );
    const deps = dependencyResult.data;
    if (deps.conversations || deps.automations || deps.mappings) {
      setError(
        `Silme engellendi: ${deps.conversations} konuşma, ${deps.automations} otomasyon ve ${deps.mappings} eşleme bu etikete bağlı.`,
      );
      return;
    }
    if (!window.confirm(`“${label.name}” kalıcı görünümden kaldırılsın mı?`))
      return;
    await apiJson(`/api/v1/labels/${label.id}`, { method: "DELETE" });
    setNotice("Kullanılmayan etiket silindi.");
    await load();
  }

  async function merge(label: Label) {
    const targetName = window.prompt(
      `“${label.name}” etiketinin birleştirileceği hedef etiket adını yazın:`,
    );
    if (!targetName) return;
    const target = labels.find(
      (item) =>
        item.id !== label.id &&
        item.name.localeCompare(targetName, "tr", { sensitivity: "base" }) ===
          0,
    );
    if (!target) {
      setError("Hedef etiket etkin listedeki adla eşleşmedi.");
      return;
    }
    await apiJson(`/api/v1/labels/${label.id}/merge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        targetLabelId: target.id,
        sourceVersion: label.version,
      }),
    });
    setNotice(`“${label.name}”, “${target.name}” ile birleştirildi.`);
    await load();
  }

  async function createCategory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await apiJson("/api/v1/label-categories", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: form.get("name"),
        description: form.get("description") || null,
        color: form.get("color"),
        selectionMode: form.get("selectionMode"),
        sortOrder: 0,
        isRequiredGroup: false,
      }),
    });
    setCategoryModal(false);
    setNotice("Kategori oluşturuldu.");
    await load();
  }

  return (
    <AppFrame
      title="Etiket Yönetim Merkezi"
      subtitle="Operasyonel konuşma sınıflandırması, kapsam yönetimi ve otomasyon bağımlılıkları."
      actions={
        canManage ? (
          <div className="inline-actions">
            <button
              className="secondary-button"
              onClick={() => setCategoryModal(true)}
            >
              <Plus size={15} /> Kategori
            </button>
            <button
              className="primary-button compact-button"
              onClick={openCreate}
            >
              <Plus size={16} /> Yeni etiket
            </button>
          </div>
        ) : undefined
      }
    >
      {notice && <div className="success-state">{notice}</div>}
      {error && <div className="form-error labels-page-error">{error}</div>}

      <section className="label-summary-grid" aria-label="Etiket özeti">
        {[
          ["Aktif", summary.active],
          ["Arşiv", summary.archived],
          ["Kullanılmayan", summary.unused],
          ["Workspace", summary.workspace],
          ["Takım", summary.team],
          ["Kanal", summary.channel],
          ["Otomasyonda", summary.automated],
        ].map(([title, value]) => (
          <article key={title}>
            <span>{title}</span>
            <strong>{value}</strong>
          </article>
        ))}
      </section>

      <section className="label-toolbar">
        <label className="label-search">
          <Search size={16} />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Etiket veya açıklama ara"
          />
        </label>
        <select
          aria-label="Kategori filtresi"
          value={categoryId}
          onChange={(event) => setCategoryId(event.target.value)}
        >
          <option value="">Tüm kategoriler</option>
          {categories.map((category) => (
            <option value={category.id} key={category.id}>
              {category.name}
            </option>
          ))}
        </select>
        <select
          aria-label="Kapsam filtresi"
          value={scope}
          onChange={(event) => setScope(event.target.value)}
        >
          <option value="">Tüm kapsamlar</option>
          <option value="workspace">Workspace</option>
          <option value="team">Takım</option>
          <option value="channel">Kanal</option>
        </select>
        <select
          aria-label="Durum filtresi"
          value={status}
          onChange={(event) => setStatus(event.target.value as LabelStatus)}
        >
          <option value="active">Aktif</option>
          <option value="archived">Arşiv</option>
        </select>
        <select
          aria-label="Kullanım filtresi"
          value={usage}
          onChange={(event) => setUsage(event.target.value)}
        >
          <option value="">Tüm kullanımlar</option>
          <option value="used">Kullanılan</option>
          <option value="unused">Kullanılmayan</option>
        </select>
        <select
          aria-label="Etiket sıralaması"
          value={sort}
          onChange={(event) => setSort(event.target.value)}
        >
          <option value="sort_order">Özel sıra</option>
          <option value="name">Ada göre</option>
          <option value="usage">Kullanıma göre</option>
          <option value="recent">Son kullanıma göre</option>
        </select>
        <button
          className="secondary-button"
          onClick={() => void load()}
          aria-label="Yenile"
        >
          <RefreshCw size={15} />
        </button>
      </section>

      {loading ? (
        <div className="skeleton-grid" />
      ) : labels.length === 0 ? (
        <div className="empty-state">
          <Tag />
          <h2>Bu filtrelere uygun etiket yok</h2>
          <p>
            Filtreleri temizleyin veya yetkiniz varsa yeni bir etiket oluşturun.
          </p>
        </div>
      ) : (
        <div className="table-card labels-table">
          <table>
            <caption className="sr-only">Etiketler</caption>
            <thead>
              <tr>
                <th>Etiket</th>
                <th>Kategori</th>
                <th>Kapsam</th>
                <th>Kullanım</th>
                <th>Son kullanım</th>
                <th>Güncelleyen</th>
                {canManage && <th>İşlemler</th>}
              </tr>
            </thead>
            <tbody>
              {labels.map((label) => (
                <tr key={label.id}>
                  <td>
                    <button
                      className="label-name-button"
                      onClick={() => void openDetail(label)}
                    >
                      <span
                        className="label-badge"
                        style={{
                          background: label.color,
                          color: labelTextColor(label.color),
                        }}
                      >
                        {label.icon} {label.name}
                      </span>
                      {label.description && <small>{label.description}</small>}
                    </button>
                  </td>
                  <td>
                    {label.category_name ?? "Kategorisiz"}
                    {label.selection_mode === "single" && (
                      <small>Tek seçim</small>
                    )}
                  </td>
                  <td>
                    <span className="scope-pill">{label.scope}</span>
                    <small>
                      {label.team_name ?? label.channel_name ?? "Tüm workspace"}
                    </small>
                  </td>
                  <td>
                    <strong>{label.usage_count}</strong> konuşma
                    {label.automation_usage_count > 0 && (
                      <small>{label.automation_usage_count} otomasyon</small>
                    )}
                  </td>
                  <td>{localDate(label.last_used_at)}</td>
                  <td>
                    {label.updated_by_name ?? "Sistem"}
                    <small>{localDate(label.updated_at)}</small>
                  </td>
                  {canManage && (
                    <td>
                      <div className="label-row-actions">
                        <button title="Düzenle" onClick={() => openEdit(label)}>
                          <Edit3 size={15} />
                        </button>
                        <button
                          title="Kopyala"
                          onClick={() => void action(label, "duplicate")}
                        >
                          <Copy size={15} />
                        </button>
                        {label.status === "active" ? (
                          <button
                            title="Arşivle"
                            onClick={() => void action(label, "archive")}
                          >
                            <Archive size={15} />
                          </button>
                        ) : (
                          <button
                            title="Geri yükle"
                            onClick={() => void action(label, "restore")}
                          >
                            <RotateCcw size={15} />
                          </button>
                        )}
                        <button
                          title="Birleştir"
                          onClick={() => void merge(label)}
                        >
                          <GitMerge size={15} />
                        </button>
                        <button
                          title="Sil"
                          disabled={label.is_protected}
                          onClick={() => void remove(label)}
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editor && (
        <div className="modal-backdrop">
          <form className="modal-card label-editor" onSubmit={save}>
            <button
              type="button"
              className="modal-close"
              onClick={() => setEditor(null)}
            >
              <X size={18} />
            </button>
            <h2>{editor.id ? "Etiketi düzenle" : "Yeni etiket"}</h2>
            <p>
              Adlar büyük/küçük harf ve boşluk farkları yok sayılarak
              benzersizdir.
            </p>
            <div className="label-editor-grid">
              <label>
                Ad
                <input
                  required
                  maxLength={80}
                  value={editor.name}
                  onChange={(event) =>
                    setEditor({ ...editor, name: event.target.value })
                  }
                />
              </label>
              <label>
                İkon / emoji
                <input
                  maxLength={40}
                  value={editor.icon}
                  onChange={(event) =>
                    setEditor({ ...editor, icon: event.target.value })
                  }
                  placeholder="⭐"
                />
              </label>
              <label className="full">
                Açıklama
                <textarea
                  maxLength={500}
                  value={editor.description}
                  onChange={(event) =>
                    setEditor({ ...editor, description: event.target.value })
                  }
                />
              </label>
              <label>
                Kategori
                <select
                  value={editor.categoryId}
                  onChange={(event) =>
                    setEditor({ ...editor, categoryId: event.target.value })
                  }
                >
                  <option value="">Kategorisiz</option>
                  {categories.map((category) => (
                    <option value={category.id} key={category.id}>
                      {category.name} ·{" "}
                      {category.selection_mode === "single"
                        ? "tek seçim"
                        : "çoklu"}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Kapsam
                <select
                  value={editor.scope}
                  onChange={(event) =>
                    setEditor({
                      ...editor,
                      scope: event.target.value as LabelScope,
                      teamId: "",
                      channelId: "",
                    })
                  }
                >
                  {canCreateWorkspaceLabels(role) && (
                    <option value="workspace">Workspace</option>
                  )}
                  <option value="team">Takım</option>
                  <option value="channel">Kanal</option>
                </select>
              </label>
              {editor.scope === "team" && (
                <label>
                  Takım
                  <select
                    required
                    value={editor.teamId}
                    onChange={(event) =>
                      setEditor({ ...editor, teamId: event.target.value })
                    }
                  >
                    <option value="">Takım seçin</option>
                    {teams.map((team) => (
                      <option value={team.id} key={team.id}>
                        {team.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {editor.scope === "channel" && (
                <label>
                  Kanal
                  <select
                    required
                    value={editor.channelId}
                    onChange={(event) =>
                      setEditor({ ...editor, channelId: event.target.value })
                    }
                  >
                    <option value="">Kanal seçin</option>
                    {channels.map((channel) => (
                      <option value={channel.id} key={channel.id}>
                        {channel.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <fieldset className="full label-color-fieldset">
                <legend>Renk</legend>
                <div className="label-color-presets">
                  {COLORS.map((color) => (
                    <button
                      type="button"
                      aria-label={color}
                      aria-pressed={editor.color === color}
                      key={color}
                      style={{ background: color }}
                      onClick={() => setEditor({ ...editor, color })}
                    />
                  ))}
                  <input
                    type="color"
                    value={editor.color}
                    onChange={(event) =>
                      setEditor({ ...editor, color: event.target.value })
                    }
                  />
                </div>
                <span
                  className="label-badge"
                  style={{
                    background: editor.color,
                    color: labelTextColor(editor.color),
                  }}
                >
                  {editor.icon} {editor.name || "Önizleme"}
                </span>
              </fieldset>
              {role === "owner" && (
                <label className="filter-checkbox full">
                  <input
                    type="checkbox"
                    checked={editor.isProtected}
                    onChange={(event) =>
                      setEditor({
                        ...editor,
                        isProtected: event.target.checked,
                      })
                    }
                  />
                  Korunan sistem etiketi
                </label>
              )}
            </div>
            <div className="modal-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => setEditor(null)}
              >
                Vazgeç
              </button>
              <button className="primary-button" disabled={saving}>
                {saving ? "Kaydediliyor…" : "Kaydet"}
              </button>
            </div>
          </form>
        </div>
      )}

      {categoryModal && (
        <div className="modal-backdrop">
          <form className="modal-card" onSubmit={createCategory}>
            <button
              type="button"
              className="modal-close"
              onClick={() => setCategoryModal(false)}
            >
              <X size={18} />
            </button>
            <h2>Yeni kategori</h2>
            <label>
              Ad
              <input name="name" maxLength={80} required />
            </label>
            <label>
              Açıklama
              <textarea name="description" maxLength={500} />
            </label>
            <label>
              Seçim modu
              <select name="selectionMode">
                <option value="multiple">Çoklu seçim</option>
                <option value="single">Tek seçim</option>
              </select>
            </label>
            <label>
              Renk
              <input name="color" type="color" defaultValue="#64748b" />
            </label>
            <div className="modal-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => setCategoryModal(false)}
              >
                Vazgeç
              </button>
              <button className="primary-button">Oluştur</button>
            </div>
          </form>
        </div>
      )}

      {detail && (
        <div className="label-detail-overlay" onClick={() => setDetail(null)}>
          <aside
            className="label-detail-drawer"
            onClick={(event) => event.stopPropagation()}
          >
            <button className="modal-close" onClick={() => setDetail(null)}>
              <X size={18} />
            </button>
            <span
              className="label-badge"
              style={{
                background: detail.color,
                color: labelTextColor(detail.color),
              }}
            >
              {detail.icon} {detail.name}
            </span>
            <h2>Etiket ayrıntıları</h2>
            <p>{detail.description || "Açıklama eklenmemiş."}</p>
            <dl>
              <div>
                <dt>Kategori</dt>
                <dd>{detail.category_name ?? "Kategorisiz"}</dd>
              </div>
              <div>
                <dt>Kapsam</dt>
                <dd>{detail.scope}</dd>
              </div>
              <div>
                <dt>Durum</dt>
                <dd>{detail.status}</dd>
              </div>
              <div>
                <dt>Sürüm</dt>
                <dd>{detail.version}</dd>
              </div>
            </dl>
            <h3>
              <BarChart3 size={17} /> Bağımlılıklar
            </h3>
            {dependencies ? (
              <div className="dependency-grid">
                <article>
                  <strong>{dependencies.conversations}</strong>
                  <span>Konuşma</span>
                </article>
                <article>
                  <strong>{dependencies.automations}</strong>
                  <span>Otomasyon</span>
                </article>
                <article>
                  <strong>{dependencies.mappings}</strong>
                  <span>Bitrix eşlemesi</span>
                </article>
              </div>
            ) : (
              <p>Yükleniyor…</p>
            )}
            {detail.is_protected && (
              <p className="protected-note">
                <ShieldCheck size={16} /> Bu etiket silmeye karşı korunuyor.
              </p>
            )}
          </aside>
        </div>
      )}
    </AppFrame>
  );
}
