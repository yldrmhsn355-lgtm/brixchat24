"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  Archive,
  Download,
  ExternalLink,
  File,
  FileImage,
  FileText,
  FolderPlus,
  Grid2X2,
  HardDrive,
  List,
  MoreHorizontal,
  Pencil,
  Eye,
  RefreshCw,
  Search,
  Send,
  Share2,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { apiFetch, apiJson } from "../lib/api";
import {
  driveConnectionError,
  driveConnectionStatus,
} from "./files-connection-presentation";

type Connection = {
  id: string;
  display_name: string;
  account_email: string | null;
  status: string;
  root_folder_id: string | null;
  shared_drive_id: string | null;
  last_health_check_at: string | null;
  last_synced_at: string | null;
  last_error_code: string | null;
};
type Asset = {
  id: string;
  sanitized_name: string;
  original_name: string;
  mime_type: string;
  size_bytes: number | null;
  category: string;
  status: string;
  provider: string;
  provider_file_id: string | null;
  provider_folder_id: string | null;
  provider_connection_id: string | null;
  contact_name: string | null;
  channel_name: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  metadata: {
    webViewLink?: string;
    internalNote?: string;
    favorite?: boolean;
    lastShare?: unknown;
  };
};
type Health = {
  connections: Connection[];
  jobs: Record<string, number>;
  files: { quarantined?: number; orphaned?: number; active?: number };
};
const nav = [
  ["recent", "Son kullanılanlar"],
  ["incoming_media", "WhatsApp medyaları"],
  ["patient", "Hasta dosyaları"],
  ["xray_cbct", "Röntgen ve CBCT"],
  ["treatment_plans", "Tedavi planları"],
  ["offers", "Teklifler"],
  ["consent_reports", "Onam ve raporlar"],
  ["invoices_payments", "Fatura ve ödemeler"],
  ["shared", "Paylaşılanlar"],
  ["favorites", "Favoriler"],
  ["ARCHIVED", "Arşiv"],
  ["trash", "Çöp kutusu"],
  ["integrations", "Entegrasyonlar"],
] as const;
const categoryLabels: Record<string, string> = {
  incoming_media: "WhatsApp medya",
  intraoral_photos: "Ağız içi fotoğraf",
  xray_cbct: "Röntgen / CBCT",
  treatment_plans: "Tedavi planı",
  offers: "Teklif",
  consent_reports: "Onam / rapor",
  invoices_payments: "Fatura / ödeme",
  other: "Diğer",
};
function bytes(value: number | null) {
  if (value == null) return "—";
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 ** 2).toFixed(1)} MB`;
}
function icon(asset: Asset) {
  return asset.mime_type.startsWith("image/") ? (
    <FileImage size={22} />
  ) : asset.mime_type === "application/pdf" ? (
    <FileText size={22} />
  ) : (
    <File size={22} />
  );
}

export function FilesWorkspace() {
  const [items, setItems] = useState<Asset[]>([]),
    [connections, setConnections] = useState<Connection[]>([]),
    [health, setHealth] = useState<Health | null>(null);
  const [active, setActive] = useState<(typeof nav)[number][0]>("recent"),
    [query, setQuery] = useState(""),
    [debouncedQuery, setDebouncedQuery] = useState("");
  const [connectionId, setConnectionId] = useState(""),
    [view, setView] = useState<"list" | "grid">("list"),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(() => {
      if (typeof window === "undefined") return "";
      const googleResult = new URLSearchParams(window.location.search).get(
        "google",
      );
      if (googleResult === "scope_missing")
        return "Google Drive izni verilmedi. Yeniden yetkilendirirken Drive erişim kutusunu işaretleyin.";
      if (googleResult === "denied")
        return "Google Drive bağlantı izni tamamlanmadı.";
      return "";
    }),
    [selected, setSelected] = useState<Set<string>>(new Set()),
    [uploading, setUploading] = useState(false);
  const [editingConnection, setEditingConnection] = useState<Connection | null>(
      null,
    ),
    [deletingConnection, setDeletingConnection] = useState<Connection | null>(
      null,
    ),
    [connectionForm, setConnectionForm] = useState({
      displayName: "",
      rootFolderId: "",
      sharedDriveId: "",
    }),
    [connectionSubmitting, setConnectionSubmitting] = useState(false);
  const [testingConnectionId, setTestingConnectionId] = useState("");
  const [previewAsset, setPreviewAsset] = useState<Asset | null>(null),
    [previewUrl, setPreviewUrl] = useState(""),
    [previewLoading, setPreviewLoading] = useState(false),
    [previewError, setPreviewError] = useState("");
  const [conversationId] = useState(() =>
    typeof window === "undefined"
      ? ""
      : (new URLSearchParams(window.location.search).get("conversationId") ??
        ""),
  );
  const input = useRef<HTMLInputElement>(null);
  const previewDialog = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!previewAsset) return;
    const trigger = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusable = () =>
      Array.from(
        previewDialog.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), iframe, video[controls], audio[controls], [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
    focusable()[0]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setPreviewAsset(null);
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (!items.length) return;
      const first = items[0]!;
      const last = items.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
      trigger?.focus();
    };
  }, [previewAsset]);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), 250);
    return () => clearTimeout(timer);
  }, [query]);
  const loadConnections = useCallback(async () => {
    try {
      const result = await apiJson<{ data: Connection[] }>(
        "/api/v1/integrations/google-drive/connections",
      );
      setConnections(result.data);
      setConnectionId((current) => {
        const stillAvailable = result.data.some(
          (item) => item.id === current && item.status !== "disconnected",
        );
        return stillAvailable
          ? current
          : (result.data.find((item) => item.status === "connected")?.id ?? "");
      });
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Bağlantılar yüklenemedi.",
      );
    }
  }, []);
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    const params = new URLSearchParams({ limit: "60" });
    if (debouncedQuery) params.set("q", debouncedQuery);
    if (connectionId) params.set("connectionId", connectionId);
    if (conversationId) params.set("conversationId", conversationId);
    if (active === "trash") params.set("trash", "true");
    else if (active === "ARCHIVED") params.set("status", "ARCHIVED");
    else if (
      [
        "incoming_media",
        "xray_cbct",
        "treatment_plans",
        "offers",
        "consent_reports",
        "invoices_payments",
      ].includes(active)
    )
      params.set("category", active);
    else if (active === "patient") params.set("status", "READY");
    try {
      const result = await apiJson<{ data: Asset[] }>(
        `/api/v1/files?${params}`,
      );
      setItems(result.data);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Dosyalar yüklenemedi.",
      );
    } finally {
      setLoading(false);
    }
  }, [active, connectionId, conversationId, debouncedQuery]);
  const loadHealth = useCallback(async () => {
    try {
      setHealth(
        (await apiJson<{ data: Health }>("/api/v1/files/operations/health"))
          .data,
      );
    } catch {
      setHealth(null);
    }
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadConnections();
      void loadHealth();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadConnections, loadHealth]);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [load]);
  const connected = connections.find((item) => item.id === connectionId);
  async function connect(connection?: Connection) {
    const endpoint = connection
      ? `/api/v1/integrations/google-drive/connections/${connection.id}/reconnect`
      : "/api/v1/integrations/google-drive/auth-url";
    try {
      const result = await apiJson<{ data: { url: string } }>(endpoint, {
        method: connection ? "POST" : "GET",
      });
      window.location.assign(result.data.url);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Google Drive bağlantısı başlatılamadı.",
      );
    }
  }
  function editConnection(connection: Connection) {
    setEditingConnection(connection);
    setConnectionForm({
      displayName: connection.display_name,
      rootFolderId: connection.root_folder_id ?? "",
      sharedDriveId: connection.shared_drive_id ?? "",
    });
    setError("");
  }
  async function saveConnection(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingConnection) return;
    setConnectionSubmitting(true);
    setError("");
    try {
      await apiJson(
        `/api/v1/integrations/google-drive/connections/${editingConnection.id}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            displayName: connectionForm.displayName,
            rootFolderId: connectionForm.rootFolderId || null,
            sharedDriveId: connectionForm.sharedDriveId || null,
          }),
        },
      );
      setEditingConnection(null);
      await loadConnections();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Bağlantı güncellenemedi.",
      );
    } finally {
      setConnectionSubmitting(false);
    }
  }
  async function removeConnection() {
    if (!deletingConnection) return;
    setConnectionSubmitting(true);
    setError("");
    try {
      await apiJson(
        `/api/v1/integrations/google-drive/connections/${deletingConnection.id}`,
        { method: "DELETE" },
      );
      setDeletingConnection(null);
      await loadConnections();
      await loadHealth();
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Google Drive bağlantısı kaldırılamadı.",
      );
    } finally {
      setConnectionSubmitting(false);
    }
  }
  async function testConnection(connection: Connection) {
    setTestingConnectionId(connection.id);
    setError("");
    try {
      await apiJson(
        `/api/v1/integrations/google-drive/connections/${connection.id}/health`,
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Google Drive bağlantısı doğrulanamadı.",
      );
    } finally {
      await loadConnections();
      setTestingConnectionId("");
    }
  }
  async function upload(file: File) {
    setUploading(true);
    setError("");
    try {
      const params = new URLSearchParams({
        category: active in categoryLabels ? active : "other",
        ...(connectionId ? { connectionId } : {}),
      });
      const response = await apiFetch(`/api/v1/files/uploads?${params}`, {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "x-filename": file.name,
          "x-mime-type": file.type || "application/octet-stream",
        },
        body: file,
      });
      if (!response.ok) {
        const body = (await response.json()) as {
          error?: { message?: string };
        };
        throw new Error(body.error?.message ?? "Dosya yüklenemedi.");
      }
      await load();
      await loadHealth();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Dosya yüklenemedi.");
    } finally {
      setUploading(false);
      if (input.current) input.current.value = "";
    }
  }
  async function newFolder() {
    if (!connectionId)
      return setError("Önce bir Google Drive hesabı bağlayın.");
    const name = window.prompt("Yeni klasör adı");
    if (!name) return;
    try {
      await apiJson("/api/v1/files/folders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          connectionId,
          name,
          ...(connected?.root_folder_id
            ? { parentId: connected.root_folder_id }
            : {}),
        }),
      });
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Klasör oluşturulamadı.",
      );
    }
  }
  async function action(
    asset: Asset,
    operation:
      | "rename"
      | "move"
      | "share"
      | "send"
      | "archive"
      | "delete"
      | "restore"
      | "favorite"
      | "preview"
      | "download",
  ) {
    try {
      if (operation === "preview") {
        setPreviewAsset(asset);
        setPreviewUrl("");
        setPreviewError("");
        setPreviewLoading(true);
        try {
          const result = await apiJson<{ data: { url: string } }>(
            `/api/v1/files/${asset.id}/download-url`,
            { method: "POST" },
          );
          setPreviewUrl(result.data.url);
        } catch (cause) {
          setPreviewError(
            cause instanceof Error ? cause.message : "Önizleme açılamadı.",
          );
        } finally {
          setPreviewLoading(false);
        }
        return;
      }
      if (operation === "download") {
        const result = await apiJson<{ data: { url: string } }>(
          `/api/v1/files/${asset.id}/download-url`,
          { method: "POST" },
        );
        window.open(result.data.url, "_blank", "noopener,noreferrer");
        return;
      }
      if (operation === "send") {
        const conversationId = window.prompt(
          "Gönderilecek konuşmanın UUID değeri",
        );
        if (!conversationId) return;
        await apiJson(`/api/v1/files/${asset.id}/send-whatsapp`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ conversationId }),
        });
      } else if (operation === "share") {
        const emailAddress = window.prompt(
          "Paylaşılacak Google hesabı e-postası (herkese açık bağlantı varsayılan olarak kapalıdır)",
        );
        if (!emailAddress) return;
        const result = await apiJson<{ data: { url: string } }>(
          `/api/v1/files/${asset.id}/share`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ emailAddress, role: "reader" }),
          },
        );
        await navigator.clipboard.writeText(result.data.url);
      } else if (operation === "favorite") {
        await apiJson(`/api/v1/files/${asset.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ favorite: !asset.metadata?.favorite }),
        });
      } else if (operation === "rename") {
        const name = window.prompt("Yeni dosya adı", asset.sanitized_name);
        if (!name) return;
        await apiJson(`/api/v1/files/${asset.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name }),
        });
      } else if (operation === "move") {
        const folderId = window.prompt(
          "Hedef Google Drive klasör ID değeri",
          asset.provider_folder_id ?? "",
        );
        if (!folderId) return;
        await apiJson(`/api/v1/files/${asset.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ folderId }),
        });
      } else {
        if (
          (operation === "delete" || operation === "archive") &&
          !window.confirm(
            `${asset.sanitized_name} için ${operation === "delete" ? "çöp kutusuna taşıma" : "arşivleme"} işlemini onaylıyor musunuz?`,
          )
        )
          return;
        await apiJson(`/api/v1/files/${asset.id}/${operation}`, {
          method: "POST",
        });
      }
      await load();
      await loadHealth();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "İşlem tamamlanamadı.");
    }
  }
  async function bulk(operation: "archive" | "delete" | "restore") {
    for (const id of selected) {
      const asset = items.find((item) => item.id === id);
      if (asset) await action(asset, operation);
    }
    setSelected(new Set());
  }
  const visibleConnections = useMemo(
    () => connections.filter((item) => item.status !== "disconnected"),
    [connections],
  );
  const visibleItems = useMemo(
    () =>
      active === "shared"
        ? items.filter((item) => Boolean(item.metadata?.lastShare))
        : active === "favorites"
          ? items.filter((item) => item.metadata?.favorite === true)
          : items,
    [active, items],
  );
  return (
    <div className="files-module">
      <div className="files-toolbar">
        <label className="files-search">
          <Search size={17} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Dosya ara"
          />
        </label>
        <input
          ref={input}
          hidden
          type="file"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void upload(file);
          }}
        />
        <button
          className="button primary"
          disabled={uploading}
          onClick={() => input.current?.click()}
        >
          <Upload size={17} />
          {uploading ? "Yükleniyor…" : "Dosya yükle"}
        </button>
        <button className="button secondary" onClick={() => void newFolder()}>
          <FolderPlus size={17} />
          Yeni klasör
        </button>
        <button className="button secondary" onClick={() => void connect()}>
          <HardDrive size={17} />
          Google Drive bağla
        </button>
        <select
          aria-label="Depolama hesabı"
          value={connectionId}
          onChange={(event) => setConnectionId(event.target.value)}
        >
          <option value="">Tüm hesaplar</option>
          {visibleConnections.map((item) => (
            <option key={item.id} value={item.id}>
              {item.display_name}
            </option>
          ))}
        </select>
        <div className="segmented">
          <button
            className={view === "list" ? "active" : ""}
            aria-label="Liste görünümü"
            onClick={() => setView("list")}
          >
            <List size={17} />
          </button>
          <button
            className={view === "grid" ? "active" : ""}
            aria-label="Grid görünümü"
            onClick={() => setView("grid")}
          >
            <Grid2X2 size={17} />
          </button>
        </div>
      </div>
      {error && (
        <div className="notice error">
          <span>{error}</span>
          <button aria-label="Hatayı kapat" onClick={() => setError("")}>
            <X size={16} />
          </button>
        </div>
      )}
      {selected.size > 0 && (
        <div className="files-bulk">
          <strong>{selected.size} dosya seçildi</strong>
          <button onClick={() => void bulk("archive")}>
            <Archive size={16} />
            Arşivle
          </button>
          <button
            onClick={() => void bulk(active === "trash" ? "restore" : "delete")}
          >
            <Trash2 size={16} />
            {active === "trash" ? "Geri yükle" : "Sil"}
          </button>
        </div>
      )}
      <div className="files-layout">
        <aside className="files-nav">
          {nav.map(([id, label]) => (
            <button
              key={id}
              className={active === id ? "active" : ""}
              onClick={() => setActive(id)}
            >
              {label}
            </button>
          ))}
        </aside>
        <section className="files-content">
          {active === "integrations" ? (
            <div className="connection-grid">
              {visibleConnections.map((item) => {
                const status = driveConnectionStatus(item);
                return (
                  <article className="connection-card" key={item.id}>
                    <div>
                      <HardDrive size={22} />
                      <div>
                        <strong>{item.display_name}</strong>
                        <p>
                          {item.account_email ?? "Hesap bilgisi bekleniyor"}
                        </p>
                      </div>
                    </div>
                    <span className={`status-pill ${status.className}`}>
                      {status.label}
                    </span>
                    <dl>
                      <dt>Son sağlık kontrolü</dt>
                      <dd>
                        {item.last_health_check_at
                          ? new Date(item.last_health_check_at).toLocaleString(
                              "tr-TR",
                            )
                          : "Henüz test edilmedi"}
                      </dd>
                      <dt>Son senkronizasyon</dt>
                      <dd>
                        {item.last_synced_at
                          ? new Date(item.last_synced_at).toLocaleString(
                              "tr-TR",
                            )
                          : "Henüz yok"}
                      </dd>
                      <dt>Hata</dt>
                      <dd>{driveConnectionError(item.last_error_code)}</dd>
                    </dl>
                    <div className="card-actions">
                      <button
                        disabled={testingConnectionId === item.id}
                        onClick={() => void testConnection(item)}
                      >
                        <Activity size={15} />
                        {testingConnectionId === item.id
                          ? "Test ediliyor…"
                          : "Bağlantıyı test et"}
                      </button>
                      <button onClick={() => editConnection(item)}>
                        <Pencil size={15} />
                        Düzenle
                      </button>
                      <button onClick={() => void connect(item)}>
                        <RefreshCw size={15} />
                        Yeniden yetkilendir
                      </button>
                      <button
                        className="danger"
                        onClick={() => setDeletingConnection(item)}
                      >
                        <Trash2 size={15} />
                        Sil
                      </button>
                    </div>
                  </article>
                );
              })}
              {visibleConnections.length === 0 && (
                <Empty
                  title="Bağlı hesap yok"
                  detail="Dosyaları Google Drive ile senkronize etmek için bir hesap bağlayın."
                />
              )}
            </div>
          ) : (
            <>
              {health && (
                <div className="files-metrics">
                  <span>
                    <strong>{health.files.active ?? 0}</strong> aktif dosya
                  </span>
                  <span>
                    <strong>{health.jobs.retry ?? 0}</strong> tekrar denenen
                  </span>
                  <span>
                    <strong>{health.files.quarantined ?? 0}</strong> karantinada
                  </span>
                  <span>
                    <strong>{health.files.orphaned ?? 0}</strong> eşleşmemiş
                  </span>
                </div>
              )}
              {loading ? (
                <div className="files-loading">Dosyalar yükleniyor…</div>
              ) : visibleItems.length === 0 ? (
                <Empty
                  title="Bu görünümde dosya yok"
                  detail="Yeni bir dosya yükleyin veya filtreleri değiştirin."
                />
              ) : view === "list" ? (
                <div className="files-table" role="table">
                  <div className="files-row header" role="row">
                    <span />
                    <span>Dosya</span>
                    <span>İlgili kişi</span>
                    <span>Kanal</span>
                    <span>Boyut</span>
                    <span>Durum</span>
                    <span>Güncelleme</span>
                    <span />
                  </div>
                  {visibleItems.map((asset) => (
                    <FileRow
                      key={asset.id}
                      asset={asset}
                      selected={selected.has(asset.id)}
                      onSelect={() =>
                        setSelected((value) => {
                          const next = new Set(value);
                          next.has(asset.id)
                            ? next.delete(asset.id)
                            : next.add(asset.id);
                          return next;
                        })
                      }
                      onAction={action}
                      trash={active === "trash"}
                    />
                  ))}
                </div>
              ) : (
                <div className="files-grid">
                  {visibleItems.map((asset) => (
                    <FileCard
                      key={asset.id}
                      asset={asset}
                      selected={selected.has(asset.id)}
                      onSelect={() =>
                        setSelected((value) => {
                          const next = new Set(value);
                          next.has(asset.id)
                            ? next.delete(asset.id)
                            : next.add(asset.id);
                          return next;
                        })
                      }
                      onAction={action}
                      trash={active === "trash"}
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </section>
      </div>
      {editingConnection && (
        <div className="modal-backdrop" role="presentation">
          <form
            className="modal-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="edit-google-connection-title"
            onSubmit={saveConnection}
          >
            <h2 id="edit-google-connection-title">
              Google Drive hesabını düzenle
            </h2>
            <p>{editingConnection.account_email}</p>
            <label>
              Görünen ad
              <input
                required
                minLength={2}
                maxLength={120}
                value={connectionForm.displayName}
                onChange={(event) =>
                  setConnectionForm((current) => ({
                    ...current,
                    displayName: event.target.value,
                  }))
                }
              />
            </label>
            <label>
              Kök klasör kimliği
              <input
                maxLength={200}
                value={connectionForm.rootFolderId}
                onChange={(event) =>
                  setConnectionForm((current) => ({
                    ...current,
                    rootFolderId: event.target.value,
                  }))
                }
                placeholder="Boş bırakılırsa Drive kök dizini kullanılır"
              />
            </label>
            <label>
              Paylaşılan Drive kimliği
              <input
                maxLength={200}
                value={connectionForm.sharedDriveId}
                onChange={(event) =>
                  setConnectionForm((current) => ({
                    ...current,
                    sharedDriveId: event.target.value,
                  }))
                }
                placeholder="İsteğe bağlı"
              />
            </label>
            <div className="modal-actions">
              <button
                type="button"
                disabled={connectionSubmitting}
                onClick={() => setEditingConnection(null)}
              >
                Vazgeç
              </button>
              <button
                className="primary-button"
                disabled={
                  connectionSubmitting ||
                  connectionForm.displayName.trim().length < 2
                }
              >
                {connectionSubmitting ? "Kaydediliyor…" : "Kaydet"}
              </button>
            </div>
          </form>
        </div>
      )}
      {deletingConnection && (
        <div className="modal-backdrop" role="presentation">
          <section
            className="modal-card confirmation-card"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="delete-google-connection-title"
          >
            <h2 id="delete-google-connection-title">
              Google Drive bağlantısını silmek istiyor musunuz?
            </h2>
            <p>
              <strong>{deletingConnection.display_name}</strong> Brixchat24’ten
              kaldırılacak ve kayıtlı erişim bilgileri temizlenecek. Google
              Drive’daki dosyalar silinmeyecek.
            </p>
            <div className="modal-actions">
              <button
                type="button"
                disabled={connectionSubmitting}
                onClick={() => setDeletingConnection(null)}
              >
                Vazgeç
              </button>
              <button
                type="button"
                className="primary-button destructive-button"
                disabled={connectionSubmitting}
                onClick={() => void removeConnection()}
              >
                {connectionSubmitting ? "Siliniyor…" : "Bağlantıyı sil"}
              </button>
            </div>
          </section>
        </div>
      )}
      {previewAsset && (
        <div
          className="file-preview-backdrop"
          role="presentation"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) setPreviewAsset(null);
          }}
        >
          <section
            ref={previewDialog}
            className="file-preview-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="file-preview-title"
          >
            <header>
              <div>
                <small>Dosya önizleme</small>
                <h2 id="file-preview-title">{previewAsset.sanitized_name}</h2>
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label="Dosya önizlemesini kapat"
                onClick={() => setPreviewAsset(null)}
              >
                <X size={20} aria-hidden="true" />
              </button>
            </header>
            <div className="file-preview-content">
              {previewLoading ? (
                <div role="status" aria-live="polite">
                  Önizleme hazırlanıyor…
                </div>
              ) : previewError ? (
                <div className="error-banner" role="alert">
                  {previewError}
                </div>
              ) : previewUrl && previewAsset.mime_type.startsWith("image/") ? (
                // Signed object URLs are dynamic and intentionally bypass Next Image optimization.
                // eslint-disable-next-line @next/next/no-img-element
                <img src={previewUrl} alt={previewAsset.sanitized_name} />
              ) : previewUrl && previewAsset.mime_type.startsWith("video/") ? (
                <video controls preload="metadata" src={previewUrl}>
                  Tarayıcınız video önizlemeyi desteklemiyor.
                </video>
              ) : previewUrl && previewAsset.mime_type.startsWith("audio/") ? (
                <audio controls preload="metadata" src={previewUrl}>
                  Tarayıcınız ses önizlemeyi desteklemiyor.
                </audio>
              ) : previewUrl &&
                (previewAsset.mime_type === "application/pdf" ||
                  previewAsset.mime_type.startsWith("text/")) ? (
                <iframe
                  src={previewUrl}
                  title={`${previewAsset.sanitized_name} önizlemesi`}
                />
              ) : (
                <div className="files-empty">
                  {icon(previewAsset)}
                  <strong>Bu dosya türü tarayıcıda önizlenemiyor</strong>
                  <p>Dosyayı güvenli bağlantı üzerinden indirebilirsiniz.</p>
                </div>
              )}
            </div>
            <footer>
              <span>
                {previewAsset.mime_type} · {bytes(previewAsset.size_bytes)}
              </span>
              <button
                type="button"
                className="primary-button"
                disabled={!previewUrl}
                onClick={() => void action(previewAsset, "download")}
              >
                <Download size={16} aria-hidden="true" />
                İndir
              </button>
            </footer>
          </section>
        </div>
      )}
    </div>
  );
}
function Empty({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="files-empty">
      <FileText size={34} />
      <strong>{title}</strong>
      <p>{detail}</p>
    </div>
  );
}
function Actions({
  asset,
  onAction,
  trash,
}: {
  asset: Asset;
  onAction: (
    asset: Asset,
    operation:
      | "rename"
      | "move"
      | "share"
      | "send"
      | "archive"
      | "delete"
      | "restore"
      | "favorite"
      | "preview"
      | "download",
  ) => Promise<void>;
  trash: boolean;
}) {
  return (
    <details className="file-actions">
      <summary aria-label="Dosya işlemleri">
        <MoreHorizontal size={18} />
      </summary>
      <div>
        {asset.metadata?.webViewLink && (
          <a href={asset.metadata.webViewLink} target="_blank" rel="noreferrer">
            <ExternalLink size={14} />
            Drive&apos;da aç
          </a>
        )}
        <button onClick={() => void onAction(asset, "preview")}>
          <Eye size={14} aria-hidden="true" />
          Önizle
        </button>
        <button onClick={() => void onAction(asset, "download")}>
          <Download size={14} />
          İndir
        </button>
        <button onClick={() => void onAction(asset, "send")}>
          <Send size={14} />
          WhatsApp ile gönder
        </button>
        <button onClick={() => void onAction(asset, "rename")}>
          Yeniden adlandır
        </button>
        <button onClick={() => void onAction(asset, "move")}>Taşı</button>
        <button onClick={() => void onAction(asset, "share")}>
          <Share2 size={14} />
          Paylaş
        </button>
        <button onClick={() => void onAction(asset, "favorite")}>
          {asset.metadata?.favorite ? "Favorilerden çıkar" : "Favorilere ekle"}
        </button>
        {trash ? (
          <button onClick={() => void onAction(asset, "restore")}>
            Geri yükle
          </button>
        ) : (
          <>
            <button onClick={() => void onAction(asset, "archive")}>
              Arşivle
            </button>
            <button
              className="danger"
              onClick={() => void onAction(asset, "delete")}
            >
              Sil
            </button>
          </>
        )}
      </div>
    </details>
  );
}
function FileRow({
  asset,
  selected,
  onSelect,
  onAction,
  trash,
}: {
  asset: Asset;
  selected: boolean;
  onSelect: () => void;
  onAction: Parameters<typeof Actions>[0]["onAction"];
  trash: boolean;
}) {
  return (
    <div className="files-row" role="row">
      <input
        type="checkbox"
        checked={selected}
        onChange={onSelect}
        aria-label={`${asset.sanitized_name} seç`}
      />
      <span className="file-name">
        {icon(asset)}
        <span>
          <strong>{asset.sanitized_name}</strong>
          <small>{categoryLabels[asset.category] ?? asset.category}</small>
        </span>
      </span>
      <span>{asset.contact_name ?? "—"}</span>
      <span>{asset.channel_name ?? "—"}</span>
      <span>{bytes(asset.size_bytes)}</span>
      <span>
        <i className={`status-dot ${asset.status.toLowerCase()}`} />
        {asset.status}
      </span>
      <span>{new Date(asset.updated_at).toLocaleDateString("tr-TR")}</span>
      <Actions asset={asset} onAction={onAction} trash={trash} />
    </div>
  );
}
function FileCard({
  asset,
  selected,
  onSelect,
  onAction,
  trash,
}: {
  asset: Asset;
  selected: boolean;
  onSelect: () => void;
  onAction: Parameters<typeof Actions>[0]["onAction"];
  trash: boolean;
}) {
  return (
    <article className={`file-card ${selected ? "selected" : ""}`}>
      <button
        className="file-card-select"
        onClick={onSelect}
        aria-label={`${asset.sanitized_name} seç`}
      >
        {selected ? "✓" : ""}
      </button>
      <div className="file-preview">{icon(asset)}</div>
      <div className="file-card-title">
        <strong>{asset.sanitized_name}</strong>
        <Actions asset={asset} onAction={onAction} trash={trash} />
      </div>
      <p>
        {categoryLabels[asset.category] ?? asset.category} ·{" "}
        {bytes(asset.size_bytes)}
      </p>
      <small>{asset.contact_name ?? "Kişi bağlantısı yok"}</small>
    </article>
  );
}
