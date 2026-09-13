"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Activity, RefreshCw } from "lucide-react";
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
  toNumber,
  type AiAgentSummary,
} from "./ai-management";

type AiRunRow = {
  id: string;
  agent_id: string;
  agent_name: string;
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
  response_preview: string | null;
};

const DECISION_OPTIONS = [
  { value: "", label: "Tüm kararlar" },
  { value: "auto_sent", label: "Otomatik gönderildi" },
  { value: "draft_created", label: "Taslak oluşturuldu" },
  { value: "suggested", label: "Önerildi" },
  { value: "handoff", label: "İnsana devir" },
  { value: "blocked", label: "Engellendi" },
  { value: "observed", label: "Gözlem" },
  { value: "skipped", label: "Atlandı" },
];

export function AiRunsWorkspace() {
  const [runs, setRuns] = useState<AiRunRow[]>([]);
  const [agents, setAgents] = useState<AiAgentSummary[]>([]);
  const [agentFilter, setAgentFilter] = useState("");
  const [decisionFilter, setDecisionFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: "100" });
      if (agentFilter) params.set("agentId", agentFilter);
      if (decisionFilter) params.set("decision", decisionFilter);
      const result = await apiJson<{ data: AiRunRow[] }>(
        `/api/v1/ai/runs?${params.toString()}`,
      );
      setRuns(result.data ?? []);
      setError("");
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Çalışmalar yüklenemedi.",
      );
    } finally {
      setLoading(false);
    }
  }, [agentFilter, decisionFilter]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    void apiJson<{ data: AiAgentSummary[] }>("/api/v1/ai/agents")
      .then((result) => setAgents(result.data ?? []))
      .catch(() => setAgents([]));
  }, []);

  return (
    <AppFrame
      title="AI Çalışmaları"
      subtitle="Ajanların her çalışmasını, kararını ve maliyetini denetleyin."
      actions={
        <button
          type="button"
          className="primary-button compact-button"
          onClick={() => void load()}
          disabled={loading}
        >
          <RefreshCw size={15} aria-hidden="true" /> Yenile
        </button>
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

      <section className="stack-card ai-panel">
        <header className="ai-panel-header">
          <div>
            <h2>Çalışma listesi</h2>
            <p className="ai-note">Son 100 çalışma gösteriliyor.</p>
          </div>
          <div className="ai-toolbar">
            <label>
              <span className="sr-only">Ajana göre filtrele</span>
              <select
                aria-label="Ajana göre filtrele"
                value={agentFilter}
                onChange={(event) => setAgentFilter(event.target.value)}
              >
                <option value="">Tüm ajanlar</option>
                {agents.map((agent) => (
                  <option value={agent.id} key={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="sr-only">Karara göre filtrele</span>
              <select
                aria-label="Karara göre filtrele"
                value={decisionFilter}
                onChange={(event) => setDecisionFilter(event.target.value)}
              >
                {DECISION_OPTIONS.map((option) => (
                  <option value={option.value} key={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </header>

        {loading ? (
          <div className="ai-skeleton-list" aria-label="Yükleniyor">
            <span className="skeleton-block" />
            <span className="skeleton-block" />
            <span className="skeleton-block" />
          </div>
        ) : runs.length === 0 ? (
          <div className="empty-state">
            <Activity aria-hidden="true" />
            <h2>Çalışma bulunamadı</h2>
            <p>
              Ajanlar mesajları işledikçe çalışmalar burada listelenir.
              Filtreleri değiştirmeyi deneyin.
            </p>
          </div>
        ) : (
          <div className="table-card ai-table-scroll ai-borderless">
            <table>
              <caption className="sr-only">AI çalışmaları</caption>
              <thead>
                <tr>
                  <th>Tarih</th>
                  <th>Ajan</th>
                  <th>Karar</th>
                  <th>Güven</th>
                  <th>Model</th>
                  <th>Maliyet</th>
                  <th>Gecikme</th>
                  <th>İşlemler</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id}>
                    <td>
                      {formatAiDate(run.started_at)}
                      <small className="ai-draft-hint">
                        {agentModeLabel(run.mode)}
                      </small>
                    </td>
                    <td>
                      <strong>{run.agent_name}</strong>
                      {run.agent_version != null && (
                        <small className="ai-draft-hint">
                          v{run.agent_version}
                        </small>
                      )}
                    </td>
                    <td>
                      <span
                        className={`ai-decision-badge ${decisionBadgeClass(run.decision)}`}
                      >
                        {decisionLabel(run.decision)}
                      </span>
                      {run.error_code && (
                        <small className="ai-error-hint">
                          {run.error_code}
                        </small>
                      )}
                    </td>
                    <td>
                      {run.confidence != null
                        ? toNumber(run.confidence).toLocaleString("tr-TR", {
                            maximumFractionDigits: 2,
                          })
                        : "—"}
                    </td>
                    <td>
                      <code className="ai-model-code">
                        {run.model_used ?? "—"}
                      </code>
                      {run.fallback_used && (
                        <small className="ai-draft-hint">Yedek model</small>
                      )}
                    </td>
                    <td>
                      {formatUsd(run.total_cost_usd)}
                      <small className="ai-draft-hint">
                        {formatCount(run.input_tokens)}/
                        {formatCount(run.output_tokens)} token
                      </small>
                    </td>
                    <td>{formatLatency(run.latency_ms)}</td>
                    <td>
                      <Link
                        className="subtle-button"
                        href={`/app/ai-chats/runs/${run.id}`}
                      >
                        İncele
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </AppFrame>
  );
}
