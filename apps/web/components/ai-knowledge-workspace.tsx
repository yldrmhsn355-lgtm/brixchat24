"use client";

import {
  useCallback,
  useEffect,
  useState,
  type FormEvent,
} from "react";
import Link from "next/link";
import {
  BookOpenText,
  FileText,
  Layers,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import { AppFrame } from "./app-frame";
import { AiNav } from "./ai-nav";
import { apiJson } from "../lib/api";
import { formatAiDate, formatCount } from "./ai-management";

type KnowledgeBase = {
  id: string;
  name: string;
  description: string | null;
  scope: string;
  channel_id: string | null;
  status: string;
  document_count: number | string | null;
  chunk_count: number | string | null;
  last_indexed_at: string | null;
  created_at: string;
};

type ChannelOption = { id: string; name: string };

export function AiKnowledgeWorkspace() {
  const [bases, setBases] = useState<KnowledgeBase[]>([]);
  const [channels, setChannels] = useState<ChannelOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [scope, setScope] = useState("workspace");
  const [pendingDelete, setPendingDelete] = useState<KnowledgeBase | null>(
    null,
  );
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await apiJson<{ data: KnowledgeBase[] }>(
        "/api/v1/ai/knowledge",
      );
      setBases(result.data ?? []);
      setError("");
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Bilgi tabanları yüklenemedi.",
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
    void apiJson<{ data: ChannelOption[] }>("/api/v1/channels")
      .then((result) => setChannels(result.data ?? []))
      .catch(() => setChannels([]));
  }, []);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (creating) return;
    const form = new FormData(event.currentTarget);
    setCreating(true);
    setError("");
    try {
      await apiJson("/api/v1/ai/knowledge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: form.get("name"),
          description: form.get("description") || undefined,
          scope,
          ...(scope === "channel" && form.get("channelId")
            ? { channelId: form.get("channelId") }
            : {}),
        }),
      });
      setCreateOpen(false);
      setScope("workspace");
      setNotice("Bilgi tabanı oluşturuldu.");
      await load();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Bilgi tabanı oluşturulamadı.",
      );
    } finally {
      setCreating(false);
    }
  }

  async function remove() {
    if (!pendingDelete || deleting) return;
    setDeleting(true);
    setError("");
    try {
      await apiJson(`/api/v1/ai/knowledge/${pendingDelete.id}`, {
        method: "DELETE",
      });
      setNotice(`“${pendingDelete.name}” arşivlendi.`);
      setPendingDelete(null);
      await load();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Bilgi tabanı arşivlenemedi.",
      );
    } finally {
      setDeleting(false);
    }
  }

  const visibleBases = bases.filter((base) => base.status !== "archived");

  return (
    <AppFrame
      title="Bilgi Tabanı"
      subtitle="Ajanların yanıtlarında kaynak olarak kullanacağı belge koleksiyonları."
      actions={
        <button
          type="button"
          className="primary-button compact-button"
          onClick={() => setCreateOpen(true)}
        >
          <Plus size={16} aria-hidden="true" /> Bilgi tabanı oluştur
        </button>
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
          <button type="button" onClick={() => void load()}>
            <RefreshCw size={14} aria-hidden="true" /> Yeniden dene
          </button>
        </div>
      )}

      {loading ? (
        <div className="ai-skeleton-list" aria-label="Yükleniyor">
          <span className="skeleton-block" />
          <span className="skeleton-block" />
        </div>
      ) : visibleBases.length === 0 ? (
        <div className="empty-state">
          <BookOpenText aria-hidden="true" />
          <h2>İlk bilgi tabanınızı oluşturun</h2>
          <p>
            SSS, ürün bilgisi ve politika belgelerini ekleyin; ajanlar
            yanıtlarını bu içerikten üretsin.
          </p>
          <button
            type="button"
            className="primary-button"
            onClick={() => setCreateOpen(true)}
          >
            <Plus size={16} aria-hidden="true" /> Bilgi tabanı oluştur
          </button>
        </div>
      ) : (
        <section className="ai-kb-grid" aria-label="Bilgi tabanları">
          {visibleBases.map((base) => (
            <article className="stack-card ai-kb-card" key={base.id}>
              <header className="ai-kb-head">
                <span className="ai-kpi-icon" aria-hidden="true">
                  <BookOpenText size={18} />
                </span>
                <div>
                  <strong>{base.name}</strong>
                  <small className="ai-note">
                    {base.scope === "workspace"
                      ? "Tüm çalışma alanı"
                      : base.scope === "channel"
                        ? "Kanala özel"
                        : "Ajana özel"}
                  </small>
                </div>
              </header>
              {base.description && (
                <p className="ai-note">{base.description}</p>
              )}
              <div className="ai-kb-stats">
                <span>
                  <FileText size={14} aria-hidden="true" />{" "}
                  {formatCount(base.document_count)} belge
                </span>
                <span>
                  <Layers size={14} aria-hidden="true" />{" "}
                  {formatCount(base.chunk_count)} parça
                </span>
              </div>
              <p className="ai-note">
                Son indeksleme: {formatAiDate(base.last_indexed_at)}
              </p>
              <div className="ai-row-actions">
                <Link
                  className="secondary-button"
                  href={`/app/ai-chats/knowledge/${base.id}`}
                >
                  Belgeleri yönet
                </Link>
                <button
                  type="button"
                  className="subtle-button icon-only danger"
                  aria-label={`${base.name} bilgi tabanını arşivle`}
                  title="Arşivle"
                  onClick={() => setPendingDelete(base)}
                >
                  <Trash2 size={15} aria-hidden="true" />
                </button>
              </div>
            </article>
          ))}
        </section>
      )}

      {createOpen && (
        <div className="modal-backdrop">
          <form className="modal-card" onSubmit={create}>
            <button
              type="button"
              className="modal-close"
              aria-label="Pencereyi kapat"
              onClick={() => setCreateOpen(false)}
            >
              <X size={18} aria-hidden="true" />
            </button>
            <h2>Yeni bilgi tabanı</h2>
            <label>
              Ad
              <input name="name" required maxLength={120} autoFocus />
            </label>
            <label>
              Açıklama
              <textarea name="description" maxLength={500} />
            </label>
            <label>
              Kapsam
              <select
                name="scope"
                value={scope}
                onChange={(event) => setScope(event.target.value)}
              >
                <option value="workspace">Tüm çalışma alanı</option>
                <option value="agent">Ajana özel</option>
                <option value="channel">Kanala özel</option>
              </select>
            </label>
            {scope === "channel" && (
              <label>
                Kanal
                <select name="channelId" required>
                  <option value="">Kanal seçin</option>
                  {channels.map((channel) => (
                    <option value={channel.id} key={channel.id}>
                      {channel.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="modal-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => setCreateOpen(false)}
              >
                Vazgeç
              </button>
              <button className="primary-button" disabled={creating}>
                {creating ? "Oluşturuluyor…" : "Oluştur"}
              </button>
            </div>
          </form>
        </div>
      )}

      {pendingDelete && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !deleting)
              setPendingDelete(null);
          }}
        >
          <section
            className="modal-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ai-kb-delete-title"
          >
            <h2 id="ai-kb-delete-title">Bilgi tabanı arşivlensin mi?</h2>
            <p>
              <strong>{pendingDelete.name}</strong> ajanların erişiminden
              kaldırılacak. Belgeler silinmez, taban arşivlenir.
            </p>
            <div className="modal-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => setPendingDelete(null)}
                disabled={deleting}
                autoFocus
              >
                Vazgeç
              </button>
              <button
                type="button"
                className="primary-button ai-danger-button"
                onClick={() => void remove()}
                disabled={deleting}
              >
                <Trash2 size={15} aria-hidden="true" />
                {deleting ? "Arşivleniyor…" : "Arşivle"}
              </button>
            </div>
          </section>
        </div>
      )}
    </AppFrame>
  );
}
