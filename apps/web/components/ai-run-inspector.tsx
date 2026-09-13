"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { AppFrame } from "./app-frame";
import { AiNav } from "./ai-nav";
import { apiJson } from "../lib/api";
import {
  agentModeLabel,
  decisionBadgeClass,
  decisionLabel,
  formatAiDate,
  formatCount,
  formatLatency,
  formatUsd,
  parseMaybeJson,
  toNumber,
} from "./ai-management";

type RunDetail = {
  id: string;
  agent_id: string;
  agent_name?: string;
  agent_version: number | null;
  conversation_id: string | null;
  mode: string | null;
  status: string;
  decision: string | null;
  confidence: number | string | null;
  requires_human: boolean;
  handoff_reason: string | null;
  model_used: string | null;
  fallback_used: boolean;
  input_tokens: number | string | null;
  output_tokens: number | string | null;
  total_cost_usd: number | string | null;
  latency_ms: number | string | null;
  started_at: string;
  completed_at: string | null;
  error_code: string | null;
  error_message: string | null;
  response_text: string | null;
  final_text: string | null;
  response_meta: unknown;
  knowledge_refs: unknown;
  tool_calls: unknown;
  prompt_meta: unknown;
};

type FeedbackRow = {
  action: string;
  final_text: string | null;
  comment: string | null;
  created_at: string;
};

const FEEDBACK_LABELS: Record<string, string> = {
  rated_good: "İyi olarak işaretlendi",
  rated_bad: "Kötü olarak işaretlendi",
  edited: "Düzenlendi",
  sent: "Gönderildi",
  discarded: "Yok sayıldı",
};

export function AiRunInspector({ runId }: { runId: string }) {
  const [run, setRun] = useState<RunDetail | null>(null);
  const [feedback, setFeedback] = useState<FeedbackRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await apiJson<{
        data: { run: RunDetail; feedback: FeedbackRow[] };
      }>(`/api/v1/ai/runs/${runId}`);
      setRun(result.data.run);
      setFeedback(result.data.feedback ?? []);
      setError("");
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Çalışma ayrıntıları yüklenemedi.",
      );
    } finally {
      setLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const knowledgeRefs = parseMaybeJson<
    Array<{ chunkId: string; documentId: string; title: string; score: number }>
  >(run?.knowledge_refs, []);
  const toolCalls = parseMaybeJson<
    Array<{
      name: string;
      status: string;
      durationMs: number;
      summary: string | null;
    }>
  >(run?.tool_calls, []);
  const promptLayers = parseMaybeJson<{
    layers?: Array<{ name: string; chars: number }>;
  }>(run?.prompt_meta, {}).layers ?? [];

  return (
    <AppFrame
      title="Çalışma incelemesi"
      subtitle="Tek bir AI çalışmasının kararı, kaynakları ve maliyeti."
      actions={
        <Link className="subtle-button" href="/app/ai-chats/runs">
          <ArrowLeft size={15} aria-hidden="true" /> Çalışmalara dön
        </Link>
      }
    >
      <AiNav />

      {error && (
        <div className="error-banner ai-feedback" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => void load()}>
            <RefreshCw size={14} aria-hidden="true" /> Yeniden dene
          </button>
        </div>
      )}

      {loading || !run ? (
        <div className="ai-skeleton-list" aria-label="Yükleniyor">
          <span className="skeleton-block" />
          <span className="skeleton-block" />
        </div>
      ) : (
        <div className="ai-inspector-grid">
          <section className="stack-card ai-detail-card">
            <h2>Özet</h2>
            <dl className="ai-meta-dl">
              <div>
                <dt>Ajan</dt>
                <dd>
                  {run.agent_name ?? run.agent_id}
                  {run.agent_version != null && ` · v${run.agent_version}`}
                </dd>
              </div>
              <div>
                <dt>Karar</dt>
                <dd>
                  <span
                    className={`ai-decision-badge ${decisionBadgeClass(run.decision)}`}
                  >
                    {decisionLabel(run.decision)}
                  </span>
                  {run.requires_human && (
                    <small className="ai-error-hint">
                      İnsan onayı gerekiyor
                    </small>
                  )}
                </dd>
              </div>
              <div>
                <dt>Mod</dt>
                <dd>{agentModeLabel(run.mode)}</dd>
              </div>
              <div>
                <dt>Güven</dt>
                <dd>
                  {run.confidence != null
                    ? toNumber(run.confidence).toLocaleString("tr-TR", {
                        maximumFractionDigits: 2,
                      })
                    : "—"}
                </dd>
              </div>
              <div>
                <dt>Devir nedeni</dt>
                <dd>{run.handoff_reason ?? "—"}</dd>
              </div>
              <div>
                <dt>Model</dt>
                <dd>
                  <code className="ai-model-code">{run.model_used ?? "—"}</code>
                  {run.fallback_used && (
                    <small className="ai-error-hint">Yedek model kullanıldı</small>
                  )}
                </dd>
              </div>
              <div>
                <dt>Token</dt>
                <dd>
                  {formatCount(run.input_tokens)} giriş /{" "}
                  {formatCount(run.output_tokens)} çıkış
                </dd>
              </div>
              <div>
                <dt>Maliyet</dt>
                <dd>{formatUsd(run.total_cost_usd)}</dd>
              </div>
              <div>
                <dt>Gecikme</dt>
                <dd>{formatLatency(run.latency_ms)}</dd>
              </div>
              <div>
                <dt>Başlangıç</dt>
                <dd>{formatAiDate(run.started_at)}</dd>
              </div>
              <div>
                <dt>Tamamlanma</dt>
                <dd>{formatAiDate(run.completed_at)}</dd>
              </div>
              {run.conversation_id && (
                <div>
                  <dt>Konuşma</dt>
                  <dd>
                    <code className="ai-model-code">{run.conversation_id}</code>
                  </dd>
                </div>
              )}
            </dl>
            {(run.error_code || run.error_message) && (
              <div className="error-banner" role="alert">
                <span>
                  {run.error_code && <strong>{run.error_code}: </strong>}
                  {run.error_message ?? "Bilinmeyen hata"}
                </span>
              </div>
            )}
          </section>

          <section className="stack-card ai-detail-card">
            <h2>Yanıt</h2>
            <div className="ai-diff">
              <article className="ai">
                <h4>AI yanıtı</h4>
                {run.response_text || "—"}
              </article>
              {run.final_text != null &&
                run.final_text !== run.response_text && (
                  <article className="human">
                    <h4>Gönderilen son metin</h4>
                    {run.final_text || "—"}
                  </article>
                )}
            </div>

            <h3 className="ai-subheading">Bilgi kaynakları</h3>
            {knowledgeRefs.length === 0 ? (
              <p className="ai-note">Bilgi tabanı kaynağı kullanılmadı.</p>
            ) : (
              <ul className="ai-plain-list">
                {knowledgeRefs.map((ref) => (
                  <li key={ref.chunkId}>
                    {ref.title}
                    <small className="ai-note">
                      {" "}
                      (skor{" "}
                      {toNumber(ref.score).toLocaleString("tr-TR", {
                        maximumFractionDigits: 2,
                      })}
                      )
                    </small>
                  </li>
                ))}
              </ul>
            )}

            <h3 className="ai-subheading">Araç çağrıları</h3>
            {toolCalls.length === 0 ? (
              <p className="ai-note">Araç kullanılmadı.</p>
            ) : (
              <ul className="ai-plain-list">
                {toolCalls.map((call, index) => (
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
            {promptLayers.length === 0 ? (
              <p className="ai-note">Katman bilgisi yok.</p>
            ) : (
              <ul className="ai-plain-list">
                {promptLayers.map((layer) => (
                  <li key={layer.name}>
                    {layer.name}
                    <small className="ai-note">
                      {" "}
                      · {formatCount(layer.chars)} karakter
                    </small>
                  </li>
                ))}
              </ul>
            )}

            <h3 className="ai-subheading">Geri bildirim geçmişi</h3>
            {feedback.length === 0 ? (
              <p className="ai-note">Geri bildirim kaydı yok.</p>
            ) : (
              <ul className="ai-plain-list">
                {feedback.map((item, index) => (
                  <li key={`${item.action}-${index}`}>
                    <strong>
                      {FEEDBACK_LABELS[item.action] ?? item.action}
                    </strong>{" "}
                    · {formatAiDate(item.created_at)}
                    {item.comment && (
                      <small className="ai-note"> — {item.comment}</small>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </AppFrame>
  );
}
