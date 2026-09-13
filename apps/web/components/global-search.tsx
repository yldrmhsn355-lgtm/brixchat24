"use client";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { Search, X } from "lucide-react";
import { apiJson } from "../lib/api";
type Result = {
  id: string;
  type: string;
  title: string;
  preview: string;
  conversationId?: string;
  messageId?: string;
  highlights: Array<{ text: string; match: boolean }>;
};
export function GlobalSearch() {
  const [open, setOpen] = useState(false),
    [q, setQ] = useState(""),
    [rows, setRows] = useState<Result[]>([]),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    router = useRouter();
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen(true);
      }
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  useEffect(() => {
    if (q.trim().length < 2) return;
    const timer = setTimeout(() => {
      setLoading(true);
      setError("");
      void apiJson<{ data: Result[] }>(
        `/api/v1/search?q=${encodeURIComponent(q)}`,
      )
        .then((x) => setRows(x.data))
        .catch((reason: unknown) => {
          setRows([]);
          setError(
            reason instanceof Error ? reason.message : "Arama tamamlanamadı.",
          );
        })
        .finally(() => setLoading(false));
    }, 250);
    return () => clearTimeout(timer);
  }, [q]);
  function go(r: Result) {
    if (r.conversationId)
      router.push(
        `/app/inbox?conversationId=${r.conversationId}${r.messageId ? `&messageId=${r.messageId}` : ""}`,
      );
    setOpen(false);
  }
  return (
    <>
      <button
        type="button"
        className="global-search-trigger"
        aria-label="Global arama (Ctrl K)"
        aria-expanded={open}
        aria-controls="global-search-dialog"
        onClick={() => setOpen(true)}
      >
        <span className="global-search-trigger-icon" aria-hidden="true">
          <Search size={17} />
        </span>
        <span className="global-search-trigger-copy">
          <strong>Akıllı arama</strong>
          <small>Mesaj, kişi veya kayıt bul</small>
        </span>
        <kbd aria-hidden="true">Ctrl K</kbd>
      </button>
      {open &&
        createPortal(
          <div
            className="search-overlay"
            role="dialog"
            aria-modal="true"
            aria-labelledby="global-search-title"
          >
            <div className="search-dialog" id="global-search-dialog">
              <header className="search-dialog-heading">
                <div>
                  <span>Hızlı erişim</span>
                  <h2 id="global-search-title">Brixchat24 içinde ara</h2>
                </div>
                <button
                  type="button"
                  aria-label="Kapat"
                  onClick={() => setOpen(false)}
                >
                  <X size={18} aria-hidden="true" />
                </button>
              </header>
              <div className="search-input">
                <Search size={18} aria-hidden="true" />
                <input
                  autoFocus
                  aria-label="Arama metni"
                  value={q}
                  onChange={(e) => {
                    setQ(e.target.value);
                    if (e.target.value.trim().length < 2) setRows([]);
                  }}
                  placeholder="Mesaj, kişi, medya, not veya Bitrix ara…"
                />
              </div>
              {loading ? (
                <p className="search-state" aria-live="polite">
                  Aranıyor…
                </p>
              ) : error ? (
                <p
                  className="search-state search-state-error"
                  role="alert"
                  aria-live="assertive"
                >
                  {error}
                </p>
              ) : rows.length === 0 ? (
                <p className="search-state">
                  {q.length > 1
                    ? "Sonuç bulunamadı."
                    : "Aramak için en az iki karakter yazın."}
                </p>
              ) : (
                <div className="search-results">
                  {rows.map((r) => (
                    <button key={`${r.type}-${r.id}`} onClick={() => go(r)}>
                      <span>{r.type}</span>
                      <strong>{r.title}</strong>
                      <p>
                        {r.highlights.map((h, i) =>
                          h.match ? <mark key={i}>{h.text}</mark> : h.text,
                        )}
                      </p>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
