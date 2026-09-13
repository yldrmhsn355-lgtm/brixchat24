"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, Check, LoaderCircle, RefreshCw, X } from "lucide-react";
import { apiFetch, apiJson } from "../lib/api";

type NotificationItem = {
  id: string;
  type: string;
  title: string;
  body: string;
  metadata: Record<string, unknown>;
  read_at: string | null;
  created_at: string;
};

export function NotificationCenter() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [markingId, setMarkingId] = useState<string | null>(null);
  const centerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await apiJson<{ data: NotificationItem[] }>(
        "/api/v1/notifications",
      );
      setItems(response.data);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Bildirimler yüklenemedi.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    void apiJson<{ data: NotificationItem[] }>("/api/v1/notifications")
      .then((response) => {
        if (active) setItems(response.data);
      })
      .catch((loadError: unknown) => {
        if (!active) return;
        setError(
          loadError instanceof Error
            ? loadError.message
            : "Bildirimler yüklenemedi.",
        );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    panelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && !centerRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
      trigger?.focus();
    };
  }, [open]);

  const markRead = async (notification: NotificationItem) => {
    if (notification.read_at || markingId) return;
    setMarkingId(notification.id);
    setError(null);
    try {
      const response = await apiFetch(
        `/api/v1/notifications/${notification.id}/read`,
        { method: "POST" },
      );
      if (!response.ok) throw new Error("Bildirim güncellenemedi.");
      setItems((current) =>
        current.map((item) =>
          item.id === notification.id
            ? { ...item, read_at: new Date().toISOString() }
            : item,
        ),
      );
    } catch (markError) {
      setError(
        markError instanceof Error
          ? markError.message
          : "Bildirim güncellenemedi.",
      );
    } finally {
      setMarkingId(null);
    }
  };

  const unreadCount = items.filter((item) => !item.read_at).length;
  const buttonLabel = unreadCount
    ? `Bildirimler, ${unreadCount} okunmamış`
    : "Bildirimler";

  return (
    <div ref={centerRef} className="notification-center">
      <button
        ref={triggerRef}
        type="button"
        className="icon-button"
        aria-label={buttonLabel}
        aria-expanded={open}
        aria-controls="notification-center-panel"
        onClick={() => setOpen((current) => !current)}
      >
        <Bell size={18} aria-hidden="true" />
        {unreadCount > 0 && <b aria-hidden="true" />}
      </button>
      {open && (
        <section
          ref={panelRef}
          id="notification-center-panel"
          className="notification-popover"
          role="dialog"
          aria-modal="false"
          aria-labelledby="notification-center-title"
          tabIndex={-1}
        >
          <header>
            <div>
              <h2 id="notification-center-title">Bildirimler</h2>
              <p>{unreadCount ? `${unreadCount} okunmamış` : "Tümü okundu"}</p>
            </div>
            <button
              type="button"
              className="icon-button"
              aria-label="Bildirimleri kapat"
              onClick={() => setOpen(false)}
            >
              <X size={18} aria-hidden="true" />
            </button>
          </header>

          {loading ? (
            <p className="notification-state" aria-live="polite">
              <LoaderCircle className="spin" size={18} aria-hidden="true" />
              Bildirimler yükleniyor…
            </p>
          ) : error ? (
            <div
              className="notification-state notification-error"
              role="alert"
              aria-live="assertive"
            >
              <p>{error}</p>
              <button
                type="button"
                className="subtle-button"
                onClick={() => void load()}
              >
                <RefreshCw size={15} aria-hidden="true" /> Yeniden dene
              </button>
            </div>
          ) : items.length === 0 ? (
            <p className="notification-state">Henüz bildiriminiz yok.</p>
          ) : (
            <ul className="notification-list">
              {items.map((item) => (
                <li className={item.read_at ? "" : "unread"} key={item.id}>
                  <article>
                    <div>
                      <strong>{item.title}</strong>
                      <time dateTime={item.created_at}>
                        {new Date(item.created_at).toLocaleString("tr-TR")}
                      </time>
                    </div>
                    <p>{item.body}</p>
                    {!item.read_at && (
                      <button
                        type="button"
                        className="notification-read-button"
                        disabled={markingId === item.id}
                        onClick={() => void markRead(item)}
                      >
                        <Check size={14} aria-hidden="true" />
                        {markingId === item.id
                          ? "İşaretleniyor…"
                          : "Okundu işaretle"}
                      </button>
                    )}
                  </article>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
