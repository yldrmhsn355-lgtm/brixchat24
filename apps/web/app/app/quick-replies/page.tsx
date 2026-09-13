"use client";

import {
  Archive,
  Copy,
  Download,
  Edit3,
  Grid2X2,
  List,
  MessageSquarePlus,
  Plus,
  Search,
  Star,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";
import { AppFrame } from "../../../components/app-frame";
import { apiFetch, apiJson } from "../../../lib/api";
import {
  normalizeShortcut,
  parseCsvRecords,
  unresolvedVariables,
} from "./quick-reply-utils";

type Reply = {
  id: string;
  title: string;
  shortcut: string;
  normalized_shortcut: string;
  content: string;
  language: string;
  fallback_language: string | null;
  scope: "organization" | "team" | "personal";
  status: "active" | "archived";
  usage_count: number;
  last_used_at: string | null;
  updated_at: string;
  version: number;
  favorite: boolean;
  team_id: string | null;
  channel_id: string | null;
  team_name: string | null;
  owner_name: string | null;
  category_id: string | null;
  category_name: string | null;
  category_color: string | null;
  updated_by_name: string | null;
  attachment_count: number;
  attachment_id: string | null;
  attachment_filename: string | null;
  tags: Array<{ id: string; name: string; color: string | null }>;
};
type Summary = {
  total: number;
  organization: number;
  team: number;
  personal: number;
  archived: number;
  recent: number;
  favorites: number;
};
type Category = {
  id: string;
  name: string;
  color: string | null;
  sort_order: number;
  usage_count: number;
};
type TagOption = {
  id: string;
  name: string;
  color: string | null;
  usage_count: number;
};
type Team = { id: string; name: string };
type Channel = { id: string; name: string };
type VariableSetting = {
  label: string;
  defaultValue: string;
  required: boolean;
  missingPolicy: "block" | "manual" | "default" | "remove";
};
type VariableDetail = {
  variable_key: string;
  label: string;
  default_value: string | null;
  required: boolean;
  missing_policy: VariableSetting["missingPolicy"];
};
type ImportPreview = {
  rowNumber: number;
  normalizedShortcut: string;
  status: "create" | "conflict" | "error";
  message: string | null;
};
type Analytics = {
  overview: {
    selected: number;
    sent: number;
    failed: number;
    variable_errors: number;
    active_agents: number;
    used_replies: number;
    selectionToSendRate: number;
  };
};
type ReplyVersion = {
  id: string;
  version: number;
  changed_fields: string[];
  created_at: string;
  actor_name: string | null;
};
type EditorState = {
  id?: string;
  version?: number;
  title: string;
  shortcut: string;
  content: string;
  scope: Reply["scope"];
  teamId: string;
  channelId: string;
  language: string;
  fallbackLanguage: string;
  categoryId: string;
  attachmentId: string;
  attachmentFilename: string;
  tagIds: string[];
  variableSettings: Record<string, VariableSetting>;
};

const emptyEditor: EditorState = {
  title: "",
  shortcut: "",
  content: "",
  scope: "personal",
  teamId: "",
  channelId: "",
  language: "tr",
  fallbackLanguage: "",
  categoryId: "",
  attachmentId: "",
  attachmentFilename: "",
  tagIds: [],
  variableSettings: {},
};
const variableCatalog = [
  "contact.first_name",
  "contact.last_name",
  "contact.full_name",
  "contact.phone",
  "contact.country",
  "contact.language",
  "assigned_user.name",
  "team.name",
  "workspace.name",
  "channel.name",
  "channel.phone_number",
  "conversation.last_message_at",
  "current_date",
  "current_time",
];

export default function QuickRepliesPage() {
  const [items, setItems] = useState<Reply[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [tagOptions, setTagOptions] = useState<TagOption[]>([]);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [scope, setScope] = useState("");
  const [teamFilter, setTeamFilter] = useState("");
  const [channelFilter, setChannelFilter] = useState("");
  const [status, setStatus] = useState<"active" | "archived">("active");
  const [language, setLanguage] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [tagId, setTagId] = useState("");
  const [sort, setSort] = useState("usage");
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [view, setView] = useState<"cards" | "list">("cards");
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveStage, setSaveStage] = useState<
    "record" | "upload" | "scan" | null
  >(null);
  const [error, setError] = useState("");
  const [importRows, setImportRows] = useState<Array<Record<string, string>>>(
    [],
  );
  const [importPreview, setImportPreview] = useState<ImportPreview[]>([]);
  const [importing, setImporting] = useState(false);
  const [pendingAttachment, setPendingAttachment] = useState<File | null>(null);
  const [versions, setVersions] = useState<ReplyVersion[]>([]);
  const [editorBaseline, setEditorBaseline] = useState("");
  const [taxonomyOpen, setTaxonomyOpen] = useState<
    "categories" | "tags" | null
  >(null);
  const [bulkCategoryId, setBulkCategoryId] = useState("");
  const [bulkTagId, setBulkTagId] = useState("");
  const [bulkScope, setBulkScope] = useState("");
  const [bulkTeamId, setBulkTeamId] = useState("");
  const importInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    const params = new URLSearchParams({
      status,
      sort,
      limit: "100",
      ...(debouncedSearch ? { search: debouncedSearch } : {}),
      ...(scope ? { scope } : {}),
      ...(teamFilter ? { teamId: teamFilter } : {}),
      ...(channelFilter ? { channelId: channelFilter } : {}),
      ...(language ? { language } : {}),
      ...(categoryId ? { categoryId } : {}),
      ...(tagId ? { tagId } : {}),
      ...(favoriteOnly ? { favorite: "true" } : {}),
    });
    try {
      const [
        list,
        totals,
        categoryResult,
        teamResult,
        analyticsResult,
        tagResult,
        channelResult,
      ] = await Promise.all([
        apiJson<{ data: Reply[] }>(`/api/v1/quick-replies?${params}`),
        apiJson<{ data: Summary }>("/api/v1/quick-replies/summary"),
        apiJson<{ data: Category[] }>("/api/v1/quick-reply-categories"),
        apiJson<{ data: Team[] }>("/api/v1/teams").catch(() => ({ data: [] })),
        apiJson<{ data: Analytics }>(
          "/api/v1/quick-replies/analytics?days=30",
        ).catch(() => ({ data: null })),
        apiJson<{ data: TagOption[] }>("/api/v1/quick-reply-tags"),
        apiJson<{ data: Channel[] }>("/api/v1/channels").catch(() => ({
          data: [],
        })),
      ]);
      setItems(list.data);
      setSummary(totals.data);
      setCategories(categoryResult.data);
      setTeams(teamResult.data);
      setAnalytics(analyticsResult.data);
      setTagOptions(tagResult.data);
      setChannels(channelResult.data);
      setSelected((ids) =>
        ids.filter((id) => list.data.some((x) => x.id === id)),
      );
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Hazır cevaplar yüklenemedi.",
      );
    } finally {
      setLoading(false);
    }
  }, [
    categoryId,
    channelFilter,
    debouncedSearch,
    favoriteOnly,
    language,
    scope,
    sort,
    status,
    tagId,
    teamFilter,
  ]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const editorDirty = Boolean(
    editor && (JSON.stringify(editor) !== editorBaseline || pendingAttachment),
  );
  useEffect(() => {
    if (!editorDirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [editorDirty]);

  function openNewEditor() {
    const next = {
      ...emptyEditor,
      tagIds: [],
      variableSettings: {},
    };
    setPendingAttachment(null);
    setVersions([]);
    setEditorBaseline(JSON.stringify(next));
    setEditor(next);
  }

  function closeEditor() {
    if (editorDirty && !confirm("Kaydedilmemiş değişiklikler silinsin mi?"))
      return;
    setPendingAttachment(null);
    setEditor(null);
    setEditorBaseline("");
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editor) return;
    if (pendingAttachment && pendingAttachment.size > 25 * 1024 * 1024) {
      setError("Ek dosya 25 MB sınırını aşıyor.");
      return;
    }
    setSaving(true);
    setSaveStage("record");
    setError("");
    let persisted: { id: string; version: number } | null = null;
    try {
      const body = {
        title: editor.title,
        shortcut: normalizeShortcut(editor.shortcut),
        content: editor.content,
        contentFormat: "text",
        language: editor.language,
        fallbackLanguage: editor.fallbackLanguage || null,
        scope: editor.scope,
        teamId: editor.scope === "team" ? editor.teamId : null,
        channelId: editor.channelId || null,
        categoryId: editor.categoryId || null,
        isActive: true,
        variables: unresolvedVariables(editor.content).map((key) => {
          const setting = editor.variableSettings[key] ?? {
            label: key,
            defaultValue: "",
            required: true,
            missingPolicy: "block" as const,
          };
          return {
            variableKey: key,
            label: setting.label || key,
            source: key.split(".")[0],
            dataType: key.includes("date")
              ? "date"
              : key.includes("time")
                ? "time"
                : "text",
            required: setting.required,
            missingPolicy: setting.missingPolicy,
            defaultValue: setting.defaultValue || null,
          };
        }),
        tagIds: editor.tagIds,
        ...(editor.id ? { version: editor.version } : {}),
      };
      const saved = await apiJson<{ data: { id: string; version: number } }>(
        editor.id
          ? `/api/v1/quick-replies/${editor.id}`
          : "/api/v1/quick-replies",
        {
          method: editor.id ? "PATCH" : "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      persisted = saved.data;
      if (pendingAttachment) {
        setSaveStage("upload");
        const upload = await apiFetch(
          `/api/v1/quick-replies/${saved.data.id}/attachments`,
          {
            method: "POST",
            headers: {
              "content-type": "application/octet-stream",
              "x-filename": pendingAttachment.name,
              "x-mime-type":
                pendingAttachment.type || "application/octet-stream",
            },
            body: pendingAttachment,
          },
        );
        if (!upload.ok) {
          const uploadBody = (await upload.json()) as {
            error?: { message?: string };
          };
          throw new Error(
            uploadBody.error?.message ??
              "Hazır cevap kaydedildi ancak eki yüklenemedi.",
          );
        }
        setSaveStage("scan");
      }
      setPendingAttachment(null);
      setEditor(null);
      setEditorBaseline("");
      await load();
    } catch (reason) {
      if (persisted && !editor.id && pendingAttachment) {
        await apiJson(`/api/v1/quick-replies/${persisted.id}`, {
          method: "DELETE",
        }).catch(() => undefined);
      } else if (persisted && !editor.id) {
        setEditor({
          ...editor,
          id: persisted.id,
          version: persisted.version,
        });
      }
      setError(
        reason instanceof Error ? reason.message : "Hazır cevap kaydedilemedi.",
      );
    } finally {
      setSaving(false);
      setSaveStage(null);
    }
  }

  async function edit(item: Reply) {
    setError("");
    try {
      const detail = await apiJson<{
        data: Reply & { variables: VariableDetail[] };
      }>(`/api/v1/quick-replies/${item.id}`);
      const next: EditorState = {
        id: item.id,
        version: detail.data.version,
        title: detail.data.title,
        shortcut: detail.data.normalized_shortcut ?? detail.data.shortcut,
        content: detail.data.content,
        scope: detail.data.scope,
        teamId: detail.data.team_id ?? "",
        channelId: detail.data.channel_id ?? "",
        language: detail.data.language,
        fallbackLanguage: detail.data.fallback_language ?? "",
        categoryId: detail.data.category_id ?? "",
        attachmentId: item.attachment_id ?? "",
        attachmentFilename: item.attachment_filename ?? "",
        tagIds: item.tags.map((tag) => tag.id),
        variableSettings: Object.fromEntries(
          detail.data.variables.map((variable) => [
            variable.variable_key,
            {
              label: variable.label,
              defaultValue: variable.default_value ?? "",
              required: variable.required,
              missingPolicy: variable.missing_policy,
            },
          ]),
        ),
      };
      setEditor(next);
      setEditorBaseline(JSON.stringify(next));
      setPendingAttachment(null);
      await loadVersions(item.id);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Hazır cevap detayı yüklenemedi.",
      );
    }
  }

  async function loadVersions(id: string) {
    const result = await apiJson<{ data: ReplyVersion[] }>(
      `/api/v1/quick-replies/${id}/versions`,
    );
    setVersions(result.data);
  }

  async function restoreVersion(version: number) {
    if (
      !editor?.id ||
      !editor.version ||
      !confirm(`${version}. sürümün içerik alanları geri yüklensin mi?`)
    )
      return;
    const result = await apiJson<{ data: Reply }>(
      `/api/v1/quick-replies/${editor.id}/versions/${version}/restore`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ currentVersion: editor.version }),
      },
    );
    setEditor({
      ...editor,
      version: result.data.version,
      title: result.data.title,
      shortcut: result.data.normalized_shortcut ?? result.data.shortcut,
      content: result.data.content,
      language: result.data.language,
      fallbackLanguage: result.data.fallback_language ?? "",
      categoryId: result.data.category_id ?? "",
    });
    await loadVersions(editor.id);
    await load();
  }

  async function removeAttachment() {
    if (!editor?.id || !editor.attachmentId) return;
    if (!confirm("Bu eki hazır cevaptan kaldırmak istiyor musunuz?")) return;
    const response = await apiFetch(
      `/api/v1/quick-replies/${editor.id}/attachments/${editor.attachmentId}`,
      { method: "DELETE" },
    );
    if (!response.ok) throw new Error("Ek güvenli biçimde kaldırılamadı.");
    setEditor({
      ...editor,
      attachmentId: "",
      attachmentFilename: "",
    });
    await load();
  }

  async function action(
    id: string,
    operation: "archive" | "restore" | "duplicate",
  ) {
    await apiJson(`/api/v1/quick-replies/${id}/${operation}`, {
      method: "POST",
      ...(operation === "duplicate"
        ? {
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ scope: "personal" }),
          }
        : {}),
    });
    await load();
  }

  async function remove(id: string) {
    if (
      !confirm(
        "Bu hazır cevap güvenli biçimde silinsin mi? Geçmiş kullanım kayıtları korunur.",
      )
    )
      return;
    await apiJson(`/api/v1/quick-replies/${id}`, { method: "DELETE" });
    await load();
  }

  async function favorite(item: Reply) {
    await apiJson(`/api/v1/quick-replies/${item.id}/favorite`, {
      method: item.favorite ? "DELETE" : "PUT",
    });
    await load();
  }

  async function bulkArchive() {
    if (!selected.length) return;
    await apiJson("/api/v1/quick-replies/bulk", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ids: selected,
        action: status === "active" ? "archive" : "restore",
      }),
    });
    setSelected([]);
    await load();
  }

  async function applyBulk(
    path: "category" | "tags" | "scope",
    body: Record<string, unknown>,
  ) {
    if (!selected.length) return;
    setError("");
    try {
      await apiJson(`/api/v1/quick-replies/bulk/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: selected, ...body }),
      });
      setSelected([]);
      await load();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Toplu işlem tamamlanamadı.",
      );
    }
  }

  async function exportCsv() {
    setError("");
    const exported = await apiJson<{ data: Array<Record<string, unknown>> }>(
      "/api/v1/quick-replies/export",
    );
    const quote = (value: unknown) =>
      `"${String(value ?? "").replaceAll('"', '""')}"`;
    const lines = [
      [
        "title",
        "shortcut",
        "content",
        "scope",
        "teamId",
        "language",
        "categoryId",
      ].join(","),
      ...exported.data.map((item) =>
        [
          item.title,
          `/${item.shortcut}`,
          item.content,
          item.scope,
          item.team_id,
          item.language,
          item.category_id,
        ]
          .map(quote)
          .join(","),
      ),
    ];
    const blob = new Blob([`\uFEFF${lines.join("\n")}`], {
      type: "text/csv;charset=utf-8",
    });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `brixchat24-hazir-cevaplar-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  function readImport(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setError("");
    void file
      .text()
      .then(async (text) => {
        const rows = parseCsvRecords(text).slice(0, 500);
        if (!rows.length)
          throw new Error("CSV dosyasında veri satırı bulunamadı.");
        const result = await apiJson<{
          data: { rows: ImportPreview[]; canCommit: boolean };
        }>("/api/v1/quick-replies/import", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ confirm: false, rows }),
        });
        setImportRows(rows);
        setImportPreview(result.data.rows);
      })
      .catch((reason) => {
        setImportRows([]);
        setImportPreview([]);
        setError(
          reason instanceof Error ? reason.message : "CSV önizlenemedi.",
        );
      });
  }

  async function commitImport() {
    if (
      importPreview.some((row) => row.status !== "create") ||
      !confirm(`${importRows.length} hazır cevap tek işlemde oluşturulsun mu?`)
    )
      return;
    setImporting(true);
    setError("");
    try {
      await apiJson("/api/v1/quick-replies/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: true, rows: importRows }),
      });
      setImportRows([]);
      setImportPreview([]);
      if (importInput.current) importInput.current.value = "";
      await load();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "İçe aktarma tamamlanamadı.",
      );
    } finally {
      setImporting(false);
    }
  }

  async function createCategory() {
    const name = prompt("Yeni organizasyon kategorisinin adı");
    if (!name?.trim()) return;
    try {
      await apiJson("/api/v1/quick-reply-categories", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), scope: "organization" }),
      });
      await load();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Kategori oluşturulamadı.",
      );
    }
  }

  async function createTag() {
    const name = prompt("Yeni etiketin adı");
    if (!name?.trim()) return;
    try {
      await apiJson("/api/v1/quick-reply-tags", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      await load();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Etiket oluşturulamadı.",
      );
    }
  }

  async function renameCategory(category: Category) {
    const name = prompt("Kategori adı", category.name);
    if (!name?.trim() || name.trim() === category.name) return;
    await apiJson(`/api/v1/quick-reply-categories/${category.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: name.trim() }),
    });
    await load();
  }

  async function moveCategory(category: Category, direction: -1 | 1) {
    const currentIndex = categories.findIndex(
      (item) => item.id === category.id,
    );
    const targetIndex = currentIndex + direction;
    if (currentIndex < 0 || targetIndex < 0 || targetIndex >= categories.length)
      return;
    const reordered = [...categories];
    const [moved] = reordered.splice(currentIndex, 1);
    reordered.splice(targetIndex, 0, moved!);
    await Promise.all(
      reordered.map((item, index) =>
        apiJson(`/api/v1/quick-reply-categories/${item.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sortOrder: index }),
        }),
      ),
    );
    await load();
  }

  async function archiveCategory(category: Category) {
    if (
      !confirm(
        `"${category.name}" kategorisi arşivlensin mi? Hazır cevaplar korunur.`,
      )
    )
      return;
    await apiJson(`/api/v1/quick-reply-categories/${category.id}`, {
      method: "DELETE",
    });
    await load();
  }

  async function renameTag(tag: TagOption) {
    const name = prompt("Etiket adı", tag.name);
    if (!name?.trim() || name.trim() === tag.name) return;
    await apiJson(`/api/v1/quick-reply-tags/${tag.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: name.trim() }),
    });
    await load();
  }

  async function deleteTag(tag: TagOption) {
    if (!confirm(`"${tag.name}" etiketi silinsin mi?`)) return;
    await apiJson(`/api/v1/quick-reply-tags/${tag.id}`, { method: "DELETE" });
    await load();
  }

  const cards = useMemo(
    () => [
      ["Toplam", summary?.total ?? 0],
      ["Organizasyon", summary?.organization ?? 0],
      ["Ekip", summary?.team ?? 0],
      ["Kişisel", summary?.personal ?? 0],
      ["Favoriler", summary?.favorites ?? 0],
      ["Arşiv", summary?.archived ?? 0],
      ["Son 7 gün", summary?.recent ?? 0],
      ...(analytics
        ? [
            ["30g gönderim", analytics.overview.sent],
            ["Seçim→gönderim", `%${analytics.overview.selectionToSendRate}`],
          ]
        : []),
    ],
    [analytics, summary],
  );

  return (
    <AppFrame
      title="Hazır Cevaplar"
      subtitle="Meta şablonlarından bağımsız, düzenlenebilir ekip yanıt merkezi."
      actions={
        <button
          className="primary-button compact-button"
          onClick={openNewEditor}
        >
          <Plus size={16} /> Yeni hazır cevap
        </button>
      }
    >
      <section className="quick-summary" aria-label="Hazır cevap özeti">
        {cards.map(([label, value]) => (
          <article key={String(label)}>
            <span>{label}</span>
            <strong>{value}</strong>
          </article>
        ))}
      </section>

      <section className="quick-toolbar">
        <label className="management-search">
          <Search size={16} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Başlık, kısayol, içerik, kategori veya etiket ara"
          />
        </label>
        <select
          aria-label="Kapsam"
          value={scope}
          onChange={(e) => setScope(e.target.value)}
        >
          <option value="">Tüm kapsamlar</option>
          <option value="organization">Organizasyon</option>
          <option value="team">Ekip</option>
          <option value="personal">Kişisel</option>
        </select>
        <select
          aria-label="Ekip"
          value={teamFilter}
          onChange={(e) => setTeamFilter(e.target.value)}
        >
          <option value="">Tüm ekipler</option>
          {teams.map((team) => (
            <option key={team.id} value={team.id}>
              {team.name}
            </option>
          ))}
        </select>
        <select
          aria-label="Kanal"
          value={channelFilter}
          onChange={(e) => setChannelFilter(e.target.value)}
        >
          <option value="">Tüm kanallar</option>
          {channels.map((channel) => (
            <option key={channel.id} value={channel.id}>
              {channel.name}
            </option>
          ))}
        </select>
        <select
          aria-label="Dil"
          value={language}
          onChange={(e) => setLanguage(e.target.value)}
        >
          <option value="">Tüm diller</option>
          <option value="tr">Türkçe</option>
          <option value="en">English</option>
          <option value="de">Deutsch</option>
          <option value="fr">Français</option>
          <option value="es">Español</option>
        </select>
        <select
          aria-label="Etiket"
          value={tagId}
          onChange={(e) => setTagId(e.target.value)}
        >
          <option value="">Tüm etiketler</option>
          {tagOptions.map((tag) => (
            <option key={tag.id} value={tag.id}>
              {tag.name}
            </option>
          ))}
        </select>
        <button onClick={() => setTaxonomyOpen("tags")}>
          <Plus size={16} /> Etiketler
        </button>
        <select
          aria-label="Kategori"
          value={categoryId}
          onChange={(e) => setCategoryId(e.target.value)}
        >
          <option value="">Tüm kategoriler</option>
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </select>
        <button onClick={() => setTaxonomyOpen("categories")}>
          <Plus size={16} /> Kategoriler
        </button>
        <select
          aria-label="Sıralama"
          value={sort}
          onChange={(e) => setSort(e.target.value)}
        >
          <option value="usage">En sık kullanılan</option>
          <option value="recent">Son kullanılan</option>
          <option value="updated">Son güncellenen</option>
          <option value="alphabetical">Alfabetik</option>
        </select>
        <button
          className={favoriteOnly ? "active" : ""}
          onClick={() => setFavoriteOnly((v) => !v)}
        >
          <Star size={16} /> Favoriler
        </button>
        <button
          onClick={() =>
            setStatus((v) => (v === "active" ? "archived" : "active"))
          }
        >
          <Archive size={16} /> {status === "active" ? "Arşiv" : "Aktifler"}
        </button>
        <span className="quick-view-toggle">
          <button
            aria-label="Kart görünümü"
            className={view === "cards" ? "active" : ""}
            onClick={() => setView("cards")}
          >
            <Grid2X2 size={16} />
          </button>
          <button
            aria-label="Liste görünümü"
            className={view === "list" ? "active" : ""}
            onClick={() => setView("list")}
          >
            <List size={16} />
          </button>
        </span>
        <input
          ref={importInput}
          hidden
          type="file"
          accept=".csv,text/csv"
          onChange={readImport}
        />
        <button onClick={() => importInput.current?.click()}>
          <Upload size={16} /> İçe aktar
        </button>
        <button onClick={() => void exportCsv()} disabled={!items.length}>
          <Download size={16} /> Dışa aktar
        </button>
      </section>

      {selected.length > 0 && (
        <div className="quick-bulk">
          <strong>{selected.length} kayıt seçildi</strong>
          <button onClick={() => void bulkArchive()}>
            {status === "active" ? "Arşivle" : "Geri yükle"}
          </button>
          <select
            aria-label="Toplu kategori"
            value={bulkCategoryId}
            onChange={(event) => setBulkCategoryId(event.target.value)}
          >
            <option value="">Kategori seç</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
          <button
            disabled={!bulkCategoryId}
            onClick={() =>
              void applyBulk("category", { categoryId: bulkCategoryId })
            }
          >
            Kategoriyi uygula
          </button>
          <select
            aria-label="Toplu etiket"
            value={bulkTagId}
            onChange={(event) => setBulkTagId(event.target.value)}
          >
            <option value="">Etiket seç</option>
            {tagOptions.map((tag) => (
              <option key={tag.id} value={tag.id}>
                {tag.name}
              </option>
            ))}
          </select>
          <button
            disabled={!bulkTagId}
            onClick={() => void applyBulk("tags", { tagIds: [bulkTagId] })}
          >
            Etiketi uygula
          </button>
          <select
            aria-label="Toplu kapsam"
            value={bulkScope}
            onChange={(event) => setBulkScope(event.target.value)}
          >
            <option value="">Kapsam seç</option>
            <option value="personal">Kişisel</option>
            <option value="team">Ekip</option>
            <option value="organization">Organizasyon</option>
          </select>
          {bulkScope === "team" && (
            <select
              aria-label="Toplu ekip"
              value={bulkTeamId}
              onChange={(event) => setBulkTeamId(event.target.value)}
            >
              <option value="">Ekip seç</option>
              {teams.map((team) => (
                <option key={team.id} value={team.id}>
                  {team.name}
                </option>
              ))}
            </select>
          )}
          <button
            disabled={!bulkScope || (bulkScope === "team" && !bulkTeamId)}
            onClick={() =>
              void applyBulk("scope", {
                scope: bulkScope,
                teamId: bulkScope === "team" ? bulkTeamId : null,
              })
            }
          >
            Kapsamı uygula
          </button>
          <button onClick={() => setSelected([])}>Seçimi temizle</button>
        </div>
      )}
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      {importRows.length > 0 && (
        <div className="quick-import-preview">
          <div>
            <strong>İçe aktarma önizlemesi</strong>
            <span>
              {importPreview.filter((row) => row.status === "create").length}{" "}
              oluşturulacak ·{" "}
              {importPreview.filter((row) => row.status !== "create").length}{" "}
              engel
            </span>
            {importPreview
              .filter((row) => row.status !== "create")
              .slice(0, 5)
              .map((row) => (
                <small key={row.rowNumber}>
                  Satır {row.rowNumber}: {row.message}
                </small>
              ))}
          </div>
          <button
            onClick={() => {
              setImportRows([]);
              setImportPreview([]);
            }}
          >
            İptal
          </button>
          <button
            className="primary-button"
            disabled={
              importing || importPreview.some((row) => row.status !== "create")
            }
            onClick={() => void commitImport()}
          >
            {importing ? "Oluşturuluyor…" : "Onayla ve oluştur"}
          </button>
        </div>
      )}

      {loading ? (
        <div className="quick-skeleton" aria-label="Yükleniyor">
          {Array.from({ length: 6 }, (_, i) => (
            <span key={i} />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="empty-state">
          <MessageSquarePlus />
          <h2>
            {search || scope || categoryId
              ? "Filtrelere uygun yanıt yok"
              : "İlk hazır cevabınızı oluşturun"}
          </h2>
          <p>
            Tekrarlanan yanıtları saniyeler içinde, kişisel veya ekip kapsamında
            kullanın.
          </p>
          <button className="primary-button" onClick={openNewEditor}>
            Hazır cevap oluştur
          </button>
        </div>
      ) : (
        <div className={view === "cards" ? "quick-grid" : "quick-list"}>
          {items.map((item) => (
            <article className="quick-card" key={item.id}>
              <input
                type="checkbox"
                aria-label={`${item.title} seç`}
                checked={selected.includes(item.id)}
                onChange={(event) =>
                  setSelected((ids) =>
                    event.target.checked
                      ? [...ids, item.id]
                      : ids.filter((id) => id !== item.id),
                  )
                }
              />
              <div className="quick-card-main">
                <header>
                  <div>
                    <code>/{item.normalized_shortcut ?? item.shortcut}</code>
                    <h2>{item.title}</h2>
                  </div>
                  <button
                    aria-label="Favori"
                    className={item.favorite ? "favorite" : ""}
                    onClick={() => void favorite(item)}
                  >
                    <Star
                      size={17}
                      fill={item.favorite ? "currentColor" : "none"}
                    />
                  </button>
                </header>
                <p>{item.content}</p>
                <div className="quick-meta">
                  <span>
                    {item.scope === "organization"
                      ? "Organizasyon"
                      : item.scope === "team"
                        ? (item.team_name ?? "Ekip")
                        : "Kişisel"}
                  </span>
                  <span>{item.language.toUpperCase()}</span>
                  {item.category_name && (
                    <span
                      style={{ borderColor: item.category_color ?? undefined }}
                    >
                      {item.category_name}
                    </span>
                  )}
                  {item.attachment_count > 0 && (
                    <span>{item.attachment_count} ek</span>
                  )}
                  <span>{item.usage_count} gönderim</span>
                </div>
                <footer>
                  <small>
                    {item.updated_by_name ?? item.owner_name ?? "Brixchat24"} ·{" "}
                    {new Date(item.updated_at).toLocaleDateString("tr-TR")}
                  </small>
                  <span>
                    <button title="Düzenle" onClick={() => void edit(item)}>
                      <Edit3 size={15} />
                    </button>
                    <button
                      title="Kişisel kopya"
                      onClick={() => void action(item.id, "duplicate")}
                    >
                      <Copy size={15} />
                    </button>
                    <button
                      title={status === "active" ? "Arşivle" : "Geri yükle"}
                      onClick={() =>
                        void action(
                          item.id,
                          status === "active" ? "archive" : "restore",
                        )
                      }
                    >
                      <Archive size={15} />
                    </button>
                    <button
                      title="Sil"
                      className="danger-button"
                      onClick={() => void remove(item.id)}
                    >
                      <Trash2 size={15} />
                    </button>
                  </span>
                </footer>
              </div>
            </article>
          ))}
        </div>
      )}

      {editor && (
        <div className="modal-backdrop">
          <form className="modal-card quick-editor" onSubmit={save}>
            <header>
              <div>
                <h2>
                  {editor.id ? "Hazır cevabı düzenle" : "Yeni hazır cevap"}
                </h2>
                <p>Göndermeden önce Inbox’ta düzenlenebilir.</p>
              </div>
              <button type="button" aria-label="Kapat" onClick={closeEditor}>
                <X size={18} />
              </button>
            </header>
            <div className="quick-editor-grid">
              <section>
                <label>
                  Başlık
                  <input
                    required
                    maxLength={120}
                    value={editor.title}
                    onChange={(e) =>
                      setEditor({ ...editor, title: e.target.value })
                    }
                  />
                </label>
                <label>
                  Kısayol
                  <div className="input-prefix">
                    <span>/</span>
                    <input
                      required
                      maxLength={40}
                      value={editor.shortcut}
                      onChange={(e) =>
                        setEditor({
                          ...editor,
                          shortcut: normalizeShortcut(e.target.value),
                        })
                      }
                    />
                  </div>
                  <small>
                    Türkçe karakterler güvenli Latin eşdeğerine çevrilir.
                  </small>
                </label>
                <label>
                  İçerik
                  <textarea
                    required
                    rows={9}
                    maxLength={4096}
                    value={editor.content}
                    onChange={(e) =>
                      setEditor({ ...editor, content: e.target.value })
                    }
                  />
                </label>
                <div className="quick-character-count">
                  {editor.content.length}/4096
                </div>
                <div className="quick-variable-picker">
                  <strong>Değişken ekle</strong>
                  <div>
                    {variableCatalog.map((key) => (
                      <button
                        type="button"
                        key={key}
                        onClick={() =>
                          setEditor({
                            ...editor,
                            content: `${editor.content}${editor.content && !editor.content.endsWith(" ") ? " " : ""}{{${key}}}`,
                          })
                        }
                      >
                        {key}
                      </button>
                    ))}
                  </div>
                </div>
                {unresolvedVariables(editor.content).length > 0 && (
                  <div className="quick-variable-config">
                    <strong>Eksik değer davranışı</strong>
                    {unresolvedVariables(editor.content).map((key) => {
                      const setting = editor.variableSettings[key] ?? {
                        label: key,
                        defaultValue: "",
                        required: true,
                        missingPolicy: "block" as const,
                      };
                      const updateSetting = (patch: Partial<VariableSetting>) =>
                        setEditor({
                          ...editor,
                          variableSettings: {
                            ...editor.variableSettings,
                            [key]: { ...setting, ...patch },
                          },
                        });
                      return (
                        <fieldset key={key}>
                          <legend>{`{{${key}}}`}</legend>
                          <label>
                            Görünen ad
                            <input
                              value={setting.label}
                              onChange={(event) =>
                                updateSetting({ label: event.target.value })
                              }
                            />
                          </label>
                          <label>
                            Değer yoksa
                            <select
                              value={setting.missingPolicy}
                              onChange={(event) =>
                                updateSetting({
                                  missingPolicy: event.target
                                    .value as VariableSetting["missingPolicy"],
                                })
                              }
                            >
                              <option value="block">Eklemeyi engelle</option>
                              <option value="manual">Temsilciden iste</option>
                              <option value="default">
                                Varsayılanı kullan
                              </option>
                              <option value="remove">Metinden çıkar</option>
                            </select>
                          </label>
                          {setting.missingPolicy === "default" && (
                            <label>
                              Varsayılan değer
                              <input
                                required
                                value={setting.defaultValue}
                                onChange={(event) =>
                                  updateSetting({
                                    defaultValue: event.target.value,
                                  })
                                }
                              />
                            </label>
                          )}
                          <label className="quick-inline-check">
                            <input
                              type="checkbox"
                              checked={setting.required}
                              onChange={(event) =>
                                updateSetting({
                                  required: event.target.checked,
                                })
                              }
                            />
                            Zorunlu
                          </label>
                        </fieldset>
                      );
                    })}
                  </div>
                )}
                <div className="form-row">
                  <label>
                    Kapsam
                    <select
                      value={editor.scope}
                      onChange={(e) =>
                        setEditor({
                          ...editor,
                          scope: e.target.value as Reply["scope"],
                        })
                      }
                    >
                      <option value="personal">Kişisel</option>
                      <option value="team">Ekip</option>
                      <option value="organization">Organizasyon</option>
                    </select>
                  </label>
                  {editor.scope === "team" && (
                    <label>
                      Ekip
                      <select
                        required
                        value={editor.teamId}
                        onChange={(e) =>
                          setEditor({ ...editor, teamId: e.target.value })
                        }
                      >
                        <option value="">Ekip seçin</option>
                        {teams.map((team) => (
                          <option key={team.id} value={team.id}>
                            {team.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <label>
                    Dil
                    <select
                      value={editor.language}
                      onChange={(e) =>
                        setEditor({ ...editor, language: e.target.value })
                      }
                    >
                      <option value="tr">Türkçe</option>
                      <option value="en">English</option>
                      <option value="de">Deutsch</option>
                      <option value="fr">Français</option>
                      <option value="es">Español</option>
                    </select>
                  </label>
                  <label>
                    Fallback dili
                    <select
                      value={editor.fallbackLanguage}
                      onChange={(e) =>
                        setEditor({
                          ...editor,
                          fallbackLanguage: e.target.value,
                        })
                      }
                    >
                      <option value="">Tanımlı değil</option>
                      <option value="tr">Türkçe</option>
                      <option value="en">English</option>
                      <option value="de">Deutsch</option>
                      <option value="fr">Français</option>
                      <option value="es">Español</option>
                    </select>
                  </label>
                  <label>
                    Kategori
                    <select
                      value={editor.categoryId}
                      onChange={(e) =>
                        setEditor({ ...editor, categoryId: e.target.value })
                      }
                    >
                      <option value="">Kategorisiz</option>
                      {categories.map((category) => (
                        <option key={category.id} value={category.id}>
                          {category.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Kanal kısıtlaması
                    <select
                      value={editor.channelId}
                      onChange={(e) =>
                        setEditor({ ...editor, channelId: e.target.value })
                      }
                    >
                      <option value="">Tüm kanallar</option>
                      {channels.map((channel) => (
                        <option key={channel.id} value={channel.id}>
                          {channel.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <fieldset className="quick-tag-picker">
                  <legend>Etiketler</legend>
                  {tagOptions.length === 0 ? (
                    <small>Henüz etiket tanımlanmamış.</small>
                  ) : (
                    tagOptions.map((tag) => (
                      <label key={tag.id}>
                        <input
                          type="checkbox"
                          checked={editor.tagIds.includes(tag.id)}
                          onChange={() =>
                            setEditor({
                              ...editor,
                              tagIds: editor.tagIds.includes(tag.id)
                                ? editor.tagIds.filter((id) => id !== tag.id)
                                : [...editor.tagIds, tag.id],
                            })
                          }
                        />
                        {tag.name}
                      </label>
                    ))
                  )}
                </fieldset>
                <label>
                  Tek ek dosya
                  {editor.attachmentId ? (
                    <span className="quick-attachment-row">
                      {editor.attachmentFilename}
                      <button
                        type="button"
                        onClick={() => void removeAttachment()}
                      >
                        Eki kaldır
                      </button>
                    </span>
                  ) : (
                    <input
                      type="file"
                      accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv"
                      onChange={(event) =>
                        setPendingAttachment(event.target.files?.[0] ?? null)
                      }
                    />
                  )}
                  <small>
                    En fazla 25 MB. Dosya kaydetmeden önce zararlı yazılım
                    taramasından geçirilir.
                  </small>
                </label>
              </section>
              <aside>
                <span>WhatsApp önizlemesi</span>
                <div className="whatsapp-preview">
                  {editor.content || "Mesaj önizlemesi"}
                  <time>
                    {new Date().toLocaleTimeString("tr-TR", {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </time>
                </div>
                {unresolvedVariables(editor.content).length > 0 && (
                  <div className="quick-variable-status">
                    <strong>
                      {unresolvedVariables(editor.content).length} değişken
                    </strong>
                    <small>
                      Inbox’ta gerçek konuşma verileriyle çözülür; eksik değer
                      gönderimi durdurur.
                    </small>
                  </div>
                )}
                <div className="quick-format-help">
                  <strong>WhatsApp biçimi</strong>
                  <code>*kalın* · _italik_ · ~üstü çizili~</code>
                  <span>Satır sonları ve emojiler korunur.</span>
                </div>
                {editor.id && (
                  <div className="quick-version-history">
                    <strong>Sürüm geçmişi</strong>
                    {versions.length === 0 ? (
                      <small>Önceki sürüm yok.</small>
                    ) : (
                      versions.slice(0, 5).map((item) => (
                        <span key={item.id}>
                          <small>
                            v{item.version} ·{" "}
                            {new Date(item.created_at).toLocaleString("tr-TR")}
                            {item.actor_name ? ` · ${item.actor_name}` : ""}
                          </small>
                          {item.version !== editor.version && (
                            <button
                              type="button"
                              onClick={() => void restoreVersion(item.version)}
                            >
                              Geri yükle
                            </button>
                          )}
                        </span>
                      ))
                    )}
                  </div>
                )}
              </aside>
            </div>
            <div className="modal-actions">
              <button type="button" onClick={closeEditor}>
                Vazgeç
              </button>
              <button className="primary-button" disabled={saving}>
                {saving
                  ? saveStage === "upload"
                    ? "Ek yükleniyor…"
                    : saveStage === "scan"
                      ? "Ek taranıyor…"
                      : "Kaydediliyor…"
                  : editor.id
                    ? "Değişiklikleri kaydet"
                    : "Oluştur"}
              </button>
            </div>
          </form>
        </div>
      )}
      {taxonomyOpen && (
        <div className="modal-backdrop">
          <section className="modal-card quick-taxonomy">
            <header>
              <div>
                <h2>
                  {taxonomyOpen === "categories"
                    ? "Kategori yönetimi"
                    : "Etiket yönetimi"}
                </h2>
                <p>
                  Adlandırma ve yaşam döngüsü değişiklikleri tüm kullanıcılara
                  yansır.
                </p>
              </div>
              <button
                type="button"
                aria-label="Kapat"
                onClick={() => setTaxonomyOpen(null)}
              >
                <X size={18} />
              </button>
            </header>
            <button
              className="primary-button"
              onClick={() =>
                void (taxonomyOpen === "categories"
                  ? createCategory()
                  : createTag())
              }
            >
              <Plus size={16} /> Yeni oluştur
            </button>
            <div className="quick-taxonomy-list">
              {(taxonomyOpen === "categories" ? categories : tagOptions).map(
                (item, index) => (
                  <article key={item.id}>
                    <span
                      className="quick-taxonomy-color"
                      style={{ background: item.color ?? "#8b7cf6" }}
                    />
                    <div>
                      <strong>{item.name}</strong>
                      <small>{item.usage_count ?? 0} hazır cevap</small>
                    </div>
                    {taxonomyOpen === "categories" && (
                      <>
                        <button
                          disabled={index === 0}
                          onClick={() =>
                            void moveCategory(item as Category, -1)
                          }
                        >
                          Yukarı
                        </button>
                        <button
                          disabled={index === categories.length - 1}
                          onClick={() => void moveCategory(item as Category, 1)}
                        >
                          Aşağı
                        </button>
                      </>
                    )}
                    <button
                      onClick={() =>
                        void (taxonomyOpen === "categories"
                          ? renameCategory(item as Category)
                          : renameTag(item as TagOption))
                      }
                    >
                      Düzenle
                    </button>
                    <button
                      className="danger-button"
                      onClick={() =>
                        void (taxonomyOpen === "categories"
                          ? archiveCategory(item as Category)
                          : deleteTag(item as TagOption))
                      }
                    >
                      {taxonomyOpen === "categories" ? "Arşivle" : "Sil"}
                    </button>
                  </article>
                ),
              )}
            </div>
          </section>
        </div>
      )}
    </AppFrame>
  );
}
