"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { MessageCirclePlus, X } from "lucide-react";

export type NewConversationChannel = {
  id: string;
  label: string;
};

export function NewConversationDialog({
  channels,
  initialChannelId,
  onClose,
  onSubmit,
}: {
  channels: NewConversationChannel[];
  initialChannelId: string;
  onClose: () => void;
  onSubmit: (input: {
    channelId: string;
    phone: string;
    displayName?: string;
  }) => Promise<void>;
}) {
  const [channelId, setChannelId] = useState(initialChannelId);
  const [phone, setPhone] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);
  const phoneRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const previousActiveElement = document.activeElement;
    phoneRef.current?.focus();
    const focusable = () =>
      Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'input, select, button:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !submitting) {
        onClose();
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
      document.removeEventListener("keydown", onKeyDown);
      if (previousActiveElement instanceof HTMLElement)
        previousActiveElement.focus();
    };
  }, [onClose, submitting]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!channelId || !phone.trim() || submitting) return;
    setSubmitting(true);
    setError("");
    try {
      await onSubmit({
        channelId,
        phone: phone.trim(),
        ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
      });
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : "Konuşma başlatılamadı.",
      );
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-backdrop new-conversation-backdrop">
      <div
        ref={dialogRef}
        className="modal-card new-conversation-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-conversation-title"
        aria-describedby="new-conversation-description"
      >
        <header>
          <span className="new-conversation-icon" aria-hidden="true">
            <MessageCirclePlus size={21} />
          </span>
          <div>
            <h2 id="new-conversation-title">Yeni konuşma</h2>
            <p id="new-conversation-description">
              Müşteriyi ve mesajın gönderileceği WhatsApp hesabını seçin.
            </p>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Yeni konuşmayı kapat"
            disabled={submitting}
            onClick={onClose}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </header>
        <form onSubmit={(event) => void submit(event)}>
          <label>
            <span>Telefon numarası</span>
            <input
              ref={phoneRef}
              type="tel"
              autoComplete="tel"
              inputMode="tel"
              placeholder="+90 5xx xxx xx xx"
              value={phone}
              disabled={submitting}
              onChange={(event) => setPhone(event.target.value)}
              required
            />
            <small>Ülke koduyla birlikte 8–15 hane girin.</small>
          </label>
          <label>
            <span>
              Müşteri adı <em>(isteğe bağlı)</em>
            </span>
            <input
              value={displayName}
              maxLength={120}
              disabled={submitting}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder="Ad Soyad"
            />
          </label>
          <label>
            <span>WhatsApp hesabı</span>
            <select
              value={channelId}
              disabled={submitting}
              onChange={(event) => setChannelId(event.target.value)}
              required
            >
              {channels.map((channel) => (
                <option value={channel.id} key={channel.id}>
                  {channel.label}
                </option>
              ))}
            </select>
          </label>
          <p className="new-conversation-notice">
            Yeni müşteriye ilk mesaj, WhatsApp kuralları gereği onaylı bir
            şablonla gönderilir. Bu adım henüz mesaj göndermez.
          </p>
          {error && (
            <p className="new-conversation-error" role="alert">
              {error}
            </p>
          )}
          <footer>
            <button
              type="button"
              className="subtle-button"
              disabled={submitting}
              onClick={onClose}
            >
              Vazgeç
            </button>
            <button
              type="submit"
              className="primary-button"
              disabled={submitting || !channelId || !phone.trim()}
            >
              {submitting ? "Hazırlanıyor…" : "Konuşmayı hazırla"}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}
