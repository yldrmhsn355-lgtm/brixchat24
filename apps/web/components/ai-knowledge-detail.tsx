"use client";

import {
  useCallback,
  useEffect,
  useState,
  type FormEvent,
} from "react";
import Link from "next/link";
import {
  ArrowLeft,
  FilePenLine,
  FileText,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import { AppFrame } from "./app-frame";
import { AiNav } from "./ai-nav";
import { apiJson } from "../lib/api";
import {
  documentStatusClass,
  documentStatusLabel,
  formatAiDate,
  formatCount,
} from "./ai-management";

type KnowledgeBase = {
  id: string;
  name: string;
  description: string | null;
  status: string;
};

type KnowledgeDocument = {
  id: string;
  title: string;
  source_type: string;
  status: "pending" | "indexing" | "ready" | "failed";
  error_message: string | null;
  chunk_count: number | string | null;
  version: number;
  indexed_at: string | null;
  language: string | null;
  content_preview: string | null;
  created_at: string;
};

const SOURCE_TYPE_LABELS: Record<string, string> = {
  text: "Serbest metin",
  faq: "SSS",
  snippet: "Kısa not",
};

export function AiKnowledgeDetail({ baseId }: { baseId: string }) {
  const [base, setBase] = useState<KnowledgeBase | null>(null);
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<{
    id: string;
    title: string;
    content: string;
  } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<KnowledgeDocument | null>(
    null,
  );
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [listResult, documentResult] = await Promise.all([
        apiJson<{ data: KnowledgeBase[] }>("/api/v1/ai/knowledge"),
        apiJson<{ data: KnowledgeDocument[] }>(
          `/api/v1/ai/knowledge/${baseId}/documents`,
        ),
      ]);
      setBase(
        (listResult.data ?? []).find((item) => item.id === baseId) ?? null,
      );
      setDocuments(documentResult.data ?? []);
      setError("");
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Belgeler yüklenemedi.",
      );
    } finally {
      setLoading(false);
    }
  }, [baseId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function addDocument(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    const form = new FormData(event.currentTarget);
    setSaving(true);
    setError("");
    try {
      await apiJson(`/api/v1/ai/knowledge/${baseId}/documents`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: form.get("title"),
          sourceType: form.get("sourceType"),
          content: form.get("content"),
          ...(form.get("language") ? { language: form.get("language") } : {}),
        }),
      });
      setAddOpen(false);
      setNotice("Belge eklendi. İndeksleme arka planda başlatıldı.");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Belge eklenemedi.");
    } finally {
      setSaving(false);
    }
  }

  async function saveEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editing || saving) return;
    setSaving(true);
    setError("");
    try {
      await apiJson(`/api/v1/ai/documents/${editing.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: editing.title,
          content: editing.content,
        }),
      });
      setEditing(null);
      setNotice("Belge güncellendi. İçerik yeniden indekslenecek.");
      await load();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Belge güncellenemedi.",
      );
    } finally {
      setSaving(false);
    }
  }

  async function removeDocument() {
    if (!pendingDelete || deleting) return;
    setDeleting(true);
    setError("");
    try {
      await apiJson(`/api/v1/ai/documents/${pendingDelete.id}`, {
        method: "DELETE",
      });
      setNotice(`“${pendingDelete.title}” silindi.`);
      setPendingDelete(null);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Belge silinemedi.");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <AppFrame
      title={base?.name ?? "Bilgi tabanı"}
      subtitle="Belgeler arka planda otomatik indekslenir; hazır olduğunda ajanlar tarafından kullanılır."
      actions={
        <div className="inline-actions">
          <Link className="subtle-button" href="/app/ai-chats/knowledge">
            <ArrowLeft size={15} aria-hidden="true" /> Bilgi tabanlarına dön
          </Link>
          <button
            type="button"
            className="primary-button compact-button"
            onClick={() => setAddOpen(true)}
          >
            <Plus size={16} aria-hidden="true" /> Belge ekle
          </button>
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
      ) : documents.length === 0 ? (
        <div className="empty-state">
          <FileText aria-hidden="true" />
          <h2>Henüz belge yok</h2>
          <p>
            SSS, ürün açıklaması veya politika metni ekleyin. Belgeler arka
            planda otomatik indekslenir.
          </p>
          <button
            type="button"
            className="primary-button"
            onClick={() => setAddOpen(true)}
          >
            <Plus size={16} aria-hidden="true" /> Belge ekle
          </button>
        </div>
      ) : (
        <section className="stack-card ai-panel">
          <header className="ai-panel-header">
            <div>
              <h2>Belgeler</h2>
              <p className="ai-note">
                {documents.length} belge · Belgeler arka planda otomatik
                indekslenir.
              </p>
            </div>
          </header>
          <div className="table-card ai-table-scroll ai-borderless">
            <table>
              <caption className="sr-only">Bilgi tabanı belgeleri</caption>
              <thead>
                <tr>
                  <th>Belge</th>
                  <th>Tür</th>
                  <th>Durum</th>
                  <th>Parça</th>
                  <th>Dil</th>
                  <th>İndeksleme</th>
                  <th>İşlemler</th>
                </tr>
              </thead>
              <tbody>
                {documents.map((document) => (
                  <tr key={document.id}>
                    <td>
                      <strong>{document.title}</strong>
                      {document.content_preview && (
                        <small className="ai-draft-hint">
                          {document.content_preview}
                        </small>
                      )}
                    </td>
                    <td>
                      {SOURCE_TYPE_LABELS[document.source_type] ??
                        document.source_type}
                    </td>
                    <td>
                      <span
                        className={`ai-decision-badge ${documentStatusClass(document.status)}`}
                      >
                        {documentStatusLabel(document.status)}
                      </span>
                      {document.status === "failed" &&
                        document.error_message && (
                          <small className="ai-error-hint">
                            {document.error_message}
                          </small>
                        )}
                    </td>
                    <td>{formatCount(document.chunk_count)}</td>
                    <td>{document.language ?? "—"}</td>
                    <td>{formatAiDate(document.indexed_at)}</td>
                    <td>
                      <div className="ai-row-actions">
                        <button
                          type="button"
                          className="subtle-button icon-only"
                          aria-label={`${document.title} belgesini düzenle`}
                          title="Düzenle"
                          onClick={() =>
                            setEditing({
                              id: document.id,
                              title: document.title,
                              content: document.content_preview ?? "",
                            })
                          }
                        >
                          <FilePenLine size={15} aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          className="subtle-button icon-only danger"
                          aria-label={`${document.title} belgesini sil`}
                          title="Sil"
                          onClick={() => setPendingDelete(document)}
                        >
                          <Trash2 size={15} aria-hidden="true" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {addOpen && (
        <div className="modal-backdrop">
          <form className="modal-card ai-modal-wide" onSubmit={addDocument}>
            <button
              type="button"
              className="modal-close"
              aria-label="Pencereyi kapat"
              onClick={() => setAddOpen(false)}
            >
              <X size={18} aria-hidden="true" />
            </button>
            <h2>Yeni belge</h2>
            <label>
              Başlık
              <input name="title" required maxLength={200} autoFocus />
            </label>
            <div className="form-row">
              <label>
                Tür
                <select name="sourceType" defaultValue="text">
                  <option value="text">Serbest metin</option>
                  <option value="faq">SSS</option>
                  <option value="snippet">Kısa not</option>
                </select>
              </label>
              <label>
                Dil
                <input name="language" maxLength={10} placeholder="tr" />
              </label>
            </div>
            <label>
              İçerik
              <textarea
                name="content"
                required
                className="ai-textarea-tall"
                placeholder="Belge içeriğini buraya yapıştırın."
              />
            </label>
            <p className="ai-note">Belgeler arka planda otomatik indekslenir.</p>
            <div className="modal-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => setAddOpen(false)}
              >
                Vazgeç
              </button>
              <button className="primary-button" disabled={saving}>
                {saving ? "Ekleniyor…" : "Belgeyi ekle"}
              </button>
            </div>
          </form>
        </div>
      )}

      {editing && (
        <div className="modal-backdrop">
          <form className="modal-card ai-modal-wide" onSubmit={saveEdit}>
            <button
              type="button"
              className="modal-close"
              aria-label="Pencereyi kapat"
              onClick={() => setEditing(null)}
            >
              <X size={18} aria-hidden="true" />
            </button>
            <h2>Belgeyi düzenle</h2>
            <label>
              Başlık
              <input
                value={editing.title}
                required
                maxLength={200}
                onChange={(event) =>
                  setEditing({ ...editing, title: event.target.value })
                }
              />
            </label>
            <label>
              İçerik
              <textarea
                className="ai-textarea-tall"
                value={editing.content}
                required
                onChange={(event) =>
                  setEditing({ ...editing, content: event.target.value })
                }
              />
            </label>
            <p className="ai-note">
              İçerik değişikliği belgeyi yeniden indeksler.
            </p>
            <div className="modal-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => setEditing(null)}
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
            aria-labelledby="ai-doc-delete-title"
          >
            <h2 id="ai-doc-delete-title">Belge silinsin mi?</h2>
            <p>
              <strong>{pendingDelete.title}</strong> bilgi tabanından
              kaldırılacak ve ajanlar bu içeriği artık kullanamayacak.
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
                onClick={() => void removeDocument()}
                disabled={deleting}
              >
                <Trash2 size={15} aria-hidden="true" />
                {deleting ? "Siliniyor…" : "Belgeyi sil"}
              </button>
            </div>
          </section>
        </div>
      )}
    </AppFrame>
  );
}
