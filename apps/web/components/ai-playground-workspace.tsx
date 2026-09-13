"use client";

import { useEffect, useRef, useState } from "react";
import {
  Bot,
  RotateCcw,
  Send,
  ThumbsDown,
  ThumbsUp,
  Trash2,
} from "lucide-react";
import { AppFrame } from "./app-frame";
import { AiNav } from "./ai-nav";
import { AiModelInput } from "./ai-model-picker";
import { apiJson } from "../lib/api";
import {
  agentModeLabel,
  decisionBadgeClass,
  decisionLabel,
  formatCount,
  formatLatency,
  formatUsd,
  toNumber,
  type AiAgentSummary,
} from "./ai-management";

type PlaygroundMessage = {
  role: "customer" | "business";
  text: string;
  fromAi?: boolean;
};

type PlaygroundResult = {
  runId: string;
  agentVersion: number;
  text: string;
  language: string | null;
  intent: string | null;
  sentiment: string | null;
  confidence: number | string | null;
  decision: string;
  requiresHuman: boolean;
  handoffReason: string | null;
  knowledgeSources: Array<{
    chunkId: string;
    documentId: string;
    title: string;
    score: number | string;
  }>;
  toolCalls: Array<{
    name: string;
    status: string;
    durationMs: number;
    summary: string | null;
  }>;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalCostUsd: number | string;
  };
  model: string;
  fallbackUsed: boolean;
  latencyMs: number;
  promptLayers: Array<{ name: string; chars: number }>;
};

export function AiPlaygroundWorkspace() {
  const [agents, setAgents] = useState<AiAgentSummary[]>([]);
  const [agentId, setAgentId] = useState("");
  const [useDraft, setUseDraft] = useState(true);
  const [modelOverride, setModelOverride] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [customerLanguage, setCustomerLanguage] = useState("");
  const [messages, setMessages] = useState<PlaygroundMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<PlaygroundResult | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [feedbackSent, setFeedbackSent] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void apiJson<{ data: AiAgentSummary[] }>("/api/v1/ai/agents")
      .then((response) => {
        const list = (response.data ?? []).filter(
          (agent) => agent.status !== "archived",
        );
        setAgents(list);
        if (list.length > 0) setAgentId((current) => current || list[0]!.id);
      })
      .catch((reason) =>
        setError(
          reason instanceof Error ? reason.message : "Ajanlar yüklenemedi.",
        ),
      );
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  async function run(baseMessages: PlaygroundMessage[]) {
    if (!agentId || running) return;
    if (!baseMessages.some((message) => message.role === "customer")) {
      setError("Çalıştırmadan önce en az bir müşteri mesajı ekleyin.");
      return;
    }
    setRunning(true);
    setError("");
    setFeedbackSent(null);
    try {
      const response = await apiJson<{ data: PlaygroundResult }>(
        "/api/v1/ai/playground",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            agentId,
            useDraft,
            messages: baseMessages.map((message) => ({
              role: message.role,
              text: message.text,
            })),
            ...(customerName ? { customerName } : {}),
            ...(customerLanguage ? { customerLanguage } : {}),
            ...(modelOverride ? { modelOverride } : {}),
          }),
        },
      );
      setResult(response.data);
      setMessages([
        ...baseMessages,
        { role: "business", text: response.data.text, fromAi: true },
      ]);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Playground çalıştırılamadı.",
      );
    } finally {
      setRunning(false);
    }
  }

  function addAndRun() {
    const text = draft.trim();
    const base = text
      ? [...messages, { role: "customer" as const, text }]
      : messages;
    if (text) {
      setMessages(base);
      setDraft("");
    }
    void run(base);
  }

  function regenerate() {
    let base = [...messages];
    while (base.length > 0 && base.at(-1)!.fromAi) base = base.slice(0, -1);
    setMessages(base);
    void run(base);
  }

  async function sendFeedback(action: "rated_good" | "rated_bad") {
    if (!result || feedbackSent) return;
    try {
      await apiJson("/api/v1/ai/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId: result.runId, action }),
      });
      setFeedbackSent(action);
      setNotice("Geri bildiriminiz kaydedildi.");
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Geri bildirim gönderilemedi.",
      );
    }
  }

  return (
    <AppFrame
      title="Playground"
      subtitle="Ajanı gerçek konuşma göndermeden test edin; karar ve maliyet ayrıntılarını inceleyin."
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
          <button type="button" onClick={() => setError("")}>
            Kapat
          </button>
        </div>
      )}

      <div className="ai-playground">
        <section className="stack-card ai-detail-card" aria-label="Test ayarları">
          <h2>Test ayarları</h2>
          <label>
            Ajan
            <select
              value={agentId}
              onChange={(event) => setAgentId(event.target.value)}
            >
              {agents.length === 0 && <option value="">Ajan bulunamadı</option>}
              {agents.map((agent) => (
                <option value={agent.id} key={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </label>
          <label className="ai-checkbox-row">
            <input
              type="checkbox"
              checked={useDraft}
              onChange={(event) => setUseDraft(event.target.checked)}
            />
            <span>Taslak sürümü kullan (kapalıysa yayın sürümü)</span>
          </label>
          <label>
            Model geçersiz kılma
            <AiModelInput
              value={modelOverride}
              placeholder="openai/gpt-4o-mini"
              onChange={setModelOverride}
            />
          </label>
          <label>
            Müşteri adı
            <input
              value={customerName}
              placeholder="Örn. Ayşe"
              onChange={(event) => setCustomerName(event.target.value)}
            />
          </label>
          <label>
            Müşteri dili
            <input
              value={customerLanguage}
              placeholder="tr"
              maxLength={10}
              onChange={(event) => setCustomerLanguage(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="subtle-button"
            onClick={() => {
              setMessages([]);
              setResult(null);
              setFeedbackSent(null);
            }}
            disabled={messages.length === 0}
          >
            <Trash2 size={14} aria-hidden="true" /> Konuşmayı temizle
          </button>
        </section>

        <section
          className="stack-card ai-chat-panel"
          aria-label="Test konuşması"
        >
          <div className="ai-chat-messages">
            {messages.length === 0 ? (
              <div className="empty-state ai-chat-empty">
                <Bot aria-hidden="true" />
                <h2>Konuşmayı başlatın</h2>
                <p>
                  Müşteri mesajı yazın ve “Çalıştır” ile ajanın yanıtını görün.
                </p>
              </div>
            ) : (
              messages.map((message, index) => (
                <div
                  className={`ai-bubble ${message.role}`}
                  key={`${index}-${message.role}`}
                >
                  <small>
                    {message.role === "customer"
                      ? "Müşteri"
                      : message.fromAi
                        ? "AI yanıtı"
                        : "İşletme"}
                  </small>
                  {message.text}
                </div>
              ))
            )}
            <div ref={messagesEndRef} />
          </div>
          <div className="ai-chat-composer">
            <label className="sr-only" htmlFor="ai-playground-input">
              Müşteri mesajı
            </label>
            <input
              id="ai-playground-input"
              value={draft}
              placeholder="Müşteri mesajı yazın…"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addAndRun();
                }
              }}
            />
            <button
              type="button"
              className="primary-button"
              onClick={addAndRun}
              disabled={running || !agentId}
            >
              <Send size={15} aria-hidden="true" />
              {running ? "Çalışıyor…" : "Çalıştır"}
            </button>
          </div>
        </section>

        <section
          className="stack-card ai-meta-panel"
          aria-label="Çalışma ayrıntıları"
        >
          <h2>Çalışma ayrıntıları</h2>
          {!result ? (
            <p className="ai-note">
              Bir çalıştırma yaptığınızda karar, güven ve maliyet bilgileri
              burada görünür.
            </p>
          ) : (
            <>
              <dl>
                <div>
                  <dt>Karar</dt>
                  <dd>
                    <span
                      className={`ai-decision-badge ${decisionBadgeClass(result.decision)}`}
                    >
                      {decisionLabel(result.decision)}
                    </span>
                    {result.requiresHuman && (
                      <small className="ai-error-hint">
                        İnsan onayı gerekiyor
                        {result.handoffReason
                          ? ` — ${result.handoffReason}`
                          : ""}
                      </small>
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Güven</dt>
                  <dd>
                    {result.confidence != null
                      ? toNumber(result.confidence).toLocaleString("tr-TR", {
                          maximumFractionDigits: 2,
                        })
                      : "—"}
                  </dd>
                </div>
                <div>
                  <dt>Dil / Niyet / Duygu</dt>
                  <dd>
                    {[result.language, result.intent, result.sentiment]
                      .map((value) => value || "—")
                      .join(" · ")}
                  </dd>
                </div>
                <div>
                  <dt>Model</dt>
                  <dd>
                    <code className="ai-model-code">{result.model}</code>
                    {result.fallbackUsed && (
                      <small className="ai-error-hint">
                        Yedek model kullanıldı
                      </small>
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Token / Maliyet / Gecikme</dt>
                  <dd>
                    {formatCount(result.usage.inputTokens)} giriş ·{" "}
                    {formatCount(result.usage.outputTokens)} çıkış ·{" "}
                    {formatUsd(result.usage.totalCostUsd)} ·{" "}
                    {formatLatency(result.latencyMs)}
                  </dd>
                </div>
                <div>
                  <dt>Sürüm</dt>
                  <dd>v{result.agentVersion}</dd>
                </div>
              </dl>

              <h3 className="ai-subheading">Bilgi kaynakları</h3>
              {result.knowledgeSources.length === 0 ? (
                <p className="ai-note">Bilgi tabanı kaynağı kullanılmadı.</p>
              ) : (
                <ul className="ai-plain-list">
                  {result.knowledgeSources.map((source) => (
                    <li key={source.chunkId}>
                      {source.title}
                      <small className="ai-note">
                        {" "}
                        (skor{" "}
                        {toNumber(source.score).toLocaleString("tr-TR", {
                          maximumFractionDigits: 2,
                        })}
                        )
                      </small>
                    </li>
                  ))}
                </ul>
              )}

              <h3 className="ai-subheading">Araç çağrıları</h3>
              {result.toolCalls.length === 0 ? (
                <p className="ai-note">Araç kullanılmadı.</p>
              ) : (
                <ul className="ai-plain-list">
                  {result.toolCalls.map((call, index) => (
                    <li key={`${call.name}-${index}`}>
                      <strong>{call.name}</strong> — {call.status} ·{" "}
                      {formatLatency(call.durationMs)}
                      {call.summary && (
                        <small className="ai-note"> {call.summary}</small>
                      )}
                    </li>
                  ))}
                </ul>
              )}

              <h3 className="ai-subheading">Prompt katmanları</h3>
              <ul className="ai-plain-list">
                {result.promptLayers.map((layer) => (
                  <li key={layer.name}>
                    {layer.name}
                    <small className="ai-note">
                      {" "}
                      · {formatCount(layer.chars)} karakter
                    </small>
                  </li>
                ))}
              </ul>

              <div className="ai-row-actions">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={regenerate}
                  disabled={running}
                >
                  <RotateCcw size={14} aria-hidden="true" /> Yeniden üret
                </button>
                <button
                  type="button"
                  className="subtle-button"
                  onClick={() => void sendFeedback("rated_good")}
                  disabled={feedbackSent != null}
                  aria-pressed={feedbackSent === "rated_good"}
                >
                  <ThumbsUp size={14} aria-hidden="true" /> İyi
                </button>
                <button
                  type="button"
                  className="subtle-button"
                  onClick={() => void sendFeedback("rated_bad")}
                  disabled={feedbackSent != null}
                  aria-pressed={feedbackSent === "rated_bad"}
                >
                  <ThumbsDown size={14} aria-hidden="true" /> Kötü
                </button>
              </div>
            </>
          )}
        </section>
      </div>
    </AppFrame>
  );
}
