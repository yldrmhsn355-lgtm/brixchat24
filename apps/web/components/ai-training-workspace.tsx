"use client";

import { useCallback, useEffect, useState } from "react";
import {
  BookOpenText,
  Check,
  GraduationCap,
  RefreshCw,
  Sparkles,
  X,
} from "lucide-react";
import { AppFrame } from "./app-frame";
import { AiNav } from "./ai-nav";
import { apiJson } from "../lib/api";
import { formatAiDate, trainingStatusLabel } from "./ai-management";

type TrainingStatus = "pending" | "approved" | "rejected";

type TrainingItem = {
  id: string;
  agent_id: string;
  agent_name: string;
  status: TrainingStatus;
  customer_message: string;
  ai_output: string | null;
  human_output: string | null;
  intent: string | null;
  language: string | null;
  notes: string | null;
  promoted_to: string | null;
  created_at: string;
};

type KnowledgeBaseOption = { id: string; name: string; status?: string };

const STATUS_TABS: Array<{ value: TrainingStatus; label: string }> = [
  { value: "pending", label: "Bekleyen" },
  { value: "approved", label: "Onaylı" },
  { value: "rejected", label: "Reddedilen" },
];

export function AiTrainingWorkspace() {
  const [status, setStatus] = useState<TrainingStatus>("pending");
  const [items, setItems] = useState<TrainingItem[]>([]);
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBaseOption[]>(
    [],
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [promoteItem, setPromoteItem] = useState<TrainingItem | null>(null);
  const [promoteKb, setPromoteKb] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await apiJson<{ data: TrainingItem[] }>(
        `/api/v1/ai/training?status=${status}`,
      );
      setItems(result.data ?? []);
      setError("");
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Eğitim örnekleri yüklenemedi.",
      );
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    void apiJson<{ data: KnowledgeBaseOption[] }>("/api/v1/ai/knowledge")
      .then((result) => setKnowledgeBases(result.data ?? []))
      .catch(() => setKnowledgeBases([]));
  }, []);

  async function review(item: TrainingItem, decision: "approved" | "rejected") {
    if (busyId) return;
    setBusyId(item.id);
    setError("");
    try {
      await apiJson(`/api/v1/ai/training/${item.id}/review`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: decision }),
      });
      setNotice(
        decision === "approved" ? "Örnek onaylandı." : "Örnek reddedildi.",
      );
      await load();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "İnceleme kaydedilemedi.",
      );
    } finally {
      setBusyId(null);
    }
  }

  async function promote(
    item: TrainingItem,
    target: "example" | "knowledge",
    knowledgeBaseId?: string,
  ) {
    if (busyId) return;
    setBusyId(item.id);
    setError("");
    try {
      await apiJson(`/api/v1/ai/training/${item.id}/promote`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          target,
          ...(knowledgeBaseId ? { knowledgeBaseId } : {}),
        }),
      });
      setNotice(
        target === "example"
          ? "Örnek, ajanın örnek yanıtlarına eklendi."
          : "Örnek, bilgi tabanına eklendi.",
      );
      setPromoteItem(null);
      setPromoteKb("");
      await load();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Örnek tanıtılamadı.",
      );
    } finally {
      setBusyId(null);
    }
  }

  return (
    <AppFrame
      title="Eğitim"
      subtitle="Temsilcilerin düzelttiği yanıtları inceleyin; onaylananları örnek veya bilgi olarak tanıtın."
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

      <div
        className="settings-tabs ai-detail-tabs"
        role="tablist"
        aria-label="Eğitim durumu filtresi"
      >
        {STATUS_TABS.map((item) => (
          <button
            key={item.value}
            type="button"
            role="tab"
            aria-selected={status === item.value}
            className={status === item.value ? "active" : undefined}
            onClick={() => setStatus(item.value)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="ai-skeleton-list" aria-label="Yükleniyor">
          <span className="skeleton-block" />
          <span className="skeleton-block" />
        </div>
      ) : items.length === 0 ? (
        <div className="empty-state">
          <GraduationCap aria-hidden="true" />
          <h2>
            {status === "pending"
              ? "Bekleyen eğitim örneği yok"
              : status === "approved"
                ? "Onaylanmış örnek yok"
                : "Reddedilmiş örnek yok"}
          </h2>
          <p>
            Temsilciler AI taslaklarını düzenleyip gönderdiğinde örnekler burada
            toplanır.
          </p>
        </div>
      ) : (
        <section className="ai-training-list" aria-label="Eğitim örnekleri">
          {items.map((item) => (
            <article className="stack-card ai-training-card" key={item.id}>
              <header className="ai-training-head">
                <div>
                  <strong>{item.agent_name}</strong>
                  <div className="ai-inline-meta">
                    <span>{formatAiDate(item.created_at)}</span>
                    {item.intent && <span>Niyet: {item.intent}</span>}
                    {item.language && <span>Dil: {item.language}</span>}
                    {item.promoted_to && (
                      <span>
                        Tanıtıldı:{" "}
                        {item.promoted_to === "example"
                          ? "Örnek yanıt"
                          : "Bilgi tabanı"}
                      </span>
                    )}
                  </div>
                </div>
                <span
                  className={`ai-decision-badge ${
                    item.status === "approved"
                      ? "positive"
                      : item.status === "rejected"
                        ? "danger"
                        : "neutral"
                  }`}
                >
                  {trainingStatusLabel(item.status)}
                </span>
              </header>

              <div className="ai-diff">
                <article className="customer">
                  <h4>Müşteri mesajı</h4>
                  {item.customer_message}
                </article>
                <article className="ai">
                  <h4>AI yanıtı</h4>
                  {item.ai_output || "—"}
                </article>
                <article className="human">
                  <h4>Temsilcinin gönderdiği yanıt</h4>
                  {item.human_output || "—"}
                </article>
              </div>

              {item.notes && (
                <p className="ai-note">İnceleme notu: {item.notes}</p>
              )}

              <div className="ai-row-actions">
                {item.status === "pending" && (
                  <>
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => void review(item, "approved")}
                      disabled={busyId === item.id}
                    >
                      <Check size={15} aria-hidden="true" /> Onayla
                    </button>
                    <button
                      type="button"
                      className="subtle-button danger"
                      onClick={() => void review(item, "rejected")}
                      disabled={busyId === item.id}
                    >
                      <X size={15} aria-hidden="true" /> Reddet
                    </button>
                  </>
                )}
                {item.status === "approved" && !item.promoted_to && (
                  <>
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => void promote(item, "example")}
                      disabled={busyId === item.id}
                    >
                      <Sparkles size={15} aria-hidden="true" /> Örnek olarak
                      tanıt
                    </button>
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => {
                        setPromoteItem(item);
                        setPromoteKb("");
                      }}
                      disabled={busyId === item.id}
                    >
                      <BookOpenText size={15} aria-hidden="true" /> Bilgi
                      tabanına ekle
                    </button>
                  </>
                )}
              </div>
            </article>
          ))}
        </section>
      )}

      {promoteItem && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setPromoteItem(null);
          }}
        >
          <section
            className="modal-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ai-promote-title"
          >
            <h2 id="ai-promote-title">Bilgi tabanına ekle</h2>
            <p className="ai-note">
              Onaylanan yanıt, seçtiğiniz bilgi tabanına belge olarak eklenir.
            </p>
            <label>
              Bilgi tabanı
              <select
                value={promoteKb}
                onChange={(event) => setPromoteKb(event.target.value)}
              >
                <option value="">Bilgi tabanı seçin</option>
                {knowledgeBases.map((kb) => (
                  <option value={kb.id} key={kb.id}>
                    {kb.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="modal-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => setPromoteItem(null)}
              >
                Vazgeç
              </button>
              <button
                type="button"
                className="primary-button"
                disabled={!promoteKb || busyId === promoteItem.id}
                onClick={() => void promote(promoteItem, "knowledge", promoteKb)}
              >
                {busyId === promoteItem.id ? "Ekleniyor…" : "Ekle"}
              </button>
            </div>
          </section>
        </div>
      )}
    </AppFrame>
  );
}
