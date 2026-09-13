"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  RefreshCw,
  XCircle,
} from "lucide-react";
import { AppFrame } from "./app-frame";
import { apiJson } from "../lib/api";

type Step = {
  position: number;
  step_type: string;
  status: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  error_code: string | null;
  completed_at: string | null;
};
type Run = {
  id: string;
  version: number;
  event_id: string;
  conversation_id: string | null;
  correlation_id: string;
  status: string;
  action_count: number;
  error_code: string | null;
  started_at: string;
  completed_at: string | null;
  steps: Step[];
};

function statusIcon(status: string) {
  if (status === "completed") return <CheckCircle2 size={17} />;
  if (status === "failed" || status === "blocked") return <XCircle size={17} />;
  return <CircleAlert size={17} />;
}

export function AutomationRunsWorkspace({ ruleId }: { ruleId: string }) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await apiJson<{ data: Run[] }>(
        `/api/v1/automations/${ruleId}/runs`,
      );
      setRuns(result.data);
      setError("");
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Çalışmalar yüklenemedi",
      );
    } finally {
      setLoading(false);
    }
  }, [ruleId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  return (
    <AppFrame
      title="Otomasyon çalışmaları"
      subtitle="Her tetikleyicinin ve aksiyon adımının sonucunu izleyin."
      actions={
        <div className="inline-actions">
          <Link className="subtle-button" href="/app/automations">
            Otomasyonlara dön
          </Link>
          <button
            className="primary-button compact-button"
            onClick={() => void load()}
            disabled={loading}
          >
            <RefreshCw size={15} /> Yenile
          </button>
        </div>
      }
    >
      {error && <div className="form-error">{error}</div>}
      {loading ? (
        <div className="skeleton-grid" />
      ) : runs.length === 0 ? (
        <div className="empty-state">
          <CircleAlert />
          <h2>Henüz çalışma yok</h2>
          <p>
            Otomasyon yayınlandıktan sonra tetiklenen çalışmalar burada görünür.
          </p>
        </div>
      ) : (
        <section className="automation-runs-list">
          {runs.map((run) => {
            const isOpen = expanded === run.id;
            return (
              <article className="automation-run-card" key={run.id}>
                <button
                  className="automation-run-summary"
                  onClick={() => setExpanded(isOpen ? null : run.id)}
                >
                  <span className={`automation-run-status ${run.status}`}>
                    {statusIcon(run.status)} {run.status}
                  </span>
                  <span>
                    <strong>v{run.version}</strong>
                    <small>
                      {new Date(run.started_at).toLocaleString("tr-TR")}
                    </small>
                  </span>
                  <span>
                    <strong>{run.action_count}</strong>
                    <small>aksiyon</small>
                  </span>
                  <span>
                    <strong>{run.conversation_id ? "Konuşma" : "Olay"}</strong>
                    <small>{run.event_id.slice(0, 8)}…</small>
                  </span>
                  <ChevronDown
                    className={isOpen ? "rotate-180" : ""}
                    size={18}
                  />
                </button>
                {isOpen && (
                  <div className="automation-run-detail">
                    <dl>
                      <div>
                        <dt>Correlation ID</dt>
                        <dd>{run.correlation_id}</dd>
                      </div>
                      <div>
                        <dt>Hata</dt>
                        <dd>{run.error_code ?? "—"}</dd>
                      </div>
                      <div>
                        <dt>Tamamlanma</dt>
                        <dd>
                          {run.completed_at
                            ? new Date(run.completed_at).toLocaleString("tr-TR")
                            : "Devam ediyor"}
                        </dd>
                      </div>
                    </dl>
                    <h3>Adımlar</h3>
                    {run.steps.length === 0 ? (
                      <p className="muted">Henüz adım kaydı yok.</p>
                    ) : (
                      <div className="automation-step-list">
                        {run.steps.map((step) => (
                          <div
                            className="automation-step"
                            key={`${run.id}-${step.position}`}
                          >
                            <span
                              className={`automation-run-status ${step.status}`}
                            >
                              {statusIcon(step.status)}
                            </span>
                            <div>
                              <strong>
                                {step.position + 1}. {step.step_type}
                              </strong>
                              <small>{step.error_code ?? step.status}</small>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </article>
            );
          })}
        </section>
      )}
    </AppFrame>
  );
}
