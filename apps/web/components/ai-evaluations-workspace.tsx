"use client";

import {
  useCallback,
  useEffect,
  useState,
  type FormEvent,
} from "react";
import Link from "next/link";
import { ClipboardCheck, Plus, RefreshCw, X } from "lucide-react";
import { AppFrame } from "./app-frame";
import { AiNav } from "./ai-nav";
import { apiJson } from "../lib/api";
import {
  formatAiDate,
  formatCount,
  parseMaybeJson,
  toNumber,
  type AiAgentSummary,
} from "./ai-management";

type EvaluationRow = {
  id: string;
  name: string;
  description: string | null;
  agent_id: string | null;
  agent_name: string | null;
  case_count: number | string | null;
  last_run: unknown;
};

type LastRun = {
  id?: string;
  status?: string;
  score?: number | string;
  passed_cases?: number;
  total_cases?: number;
  started_at?: string;
};

export function AiEvaluationsWorkspace() {
  const [evaluations, setEvaluations] = useState<EvaluationRow[]>([]);
  const [agents, setAgents] = useState<AiAgentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await apiJson<{ data: EvaluationRow[] }>(
        "/api/v1/ai/evaluations",
      );
      setEvaluations(result.data ?? []);
      setError("");
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Değerlendirmeler yüklenemedi.",
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
    void apiJson<{ data: AiAgentSummary[] }>("/api/v1/ai/agents")
      .then((result) =>
        setAgents(
          (result.data ?? []).filter((agent) => agent.status !== "archived"),
        ),
      )
      .catch(() => setAgents([]));
  }, []);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (creating) return;
    const form = new FormData(event.currentTarget);
    setCreating(true);
    setError("");
    try {
      await apiJson("/api/v1/ai/evaluations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: form.get("name"),
          description: form.get("description") || undefined,
          ...(form.get("agentId") ? { agentId: form.get("agentId") } : {}),
        }),
      });
      setCreateOpen(false);
      setNotice("Değerlendirme seti oluşturuldu.");
      await load();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Değerlendirme seti oluşturulamadı.",
      );
    } finally {
      setCreating(false);
    }
  }

  return (
    <AppFrame
      title="Değerlendirme"
      subtitle="Test senaryolarıyla ajan kalitesini ölçün ve sürümler arasında karşılaştırın."
      actions={
        <button
          type="button"
          className="primary-button compact-button"
          onClick={() => setCreateOpen(true)}
        >
          <Plus size={16} aria-hidden="true" /> Set oluştur
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
      ) : evaluations.length === 0 ? (
        <div className="empty-state">
          <ClipboardCheck aria-hidden="true" />
          <h2>İlk değerlendirme setinizi oluşturun</h2>
          <p>
            Sık gelen müşteri sorularını test senaryosuna dönüştürün; her sürüm
            öncesi otomatik kontrol edin.
          </p>
          <button
            type="button"
            className="primary-button"
            onClick={() => setCreateOpen(true)}
          >
            <Plus size={16} aria-hidden="true" /> Set oluştur
          </button>
        </div>
      ) : (
        <section className="stack-card ai-panel">
          <header className="ai-panel-header">
            <div>
              <h2>Değerlendirme setleri</h2>
              <p className="ai-note">
                Son çalıştırma skorları ve senaryo sayıları.
              </p>
            </div>
          </header>
          <div className="table-card ai-table-scroll ai-borderless">
            <table>
              <caption className="sr-only">Değerlendirme setleri</caption>
              <thead>
                <tr>
                  <th>Set</th>
                  <th>Ajan</th>
                  <th>Senaryo</th>
                  <th>Son skor</th>
                  <th>Son çalıştırma</th>
                  <th>İşlemler</th>
                </tr>
              </thead>
              <tbody>
                {evaluations.map((evaluation) => {
                  const lastRun = parseMaybeJson<LastRun>(
                    evaluation.last_run,
                    {},
                  );
                  return (
                    <tr key={evaluation.id}>
                      <td>
                        <Link
                          className="ai-row-title"
                          href={`/app/ai-chats/evaluations/${evaluation.id}`}
                        >
                          <strong>{evaluation.name}</strong>
                          {evaluation.description && (
                            <small>{evaluation.description}</small>
                          )}
                        </Link>
                      </td>
                      <td>{evaluation.agent_name ?? "Serbest"}</td>
                      <td>{formatCount(evaluation.case_count)}</td>
                      <td>
                        {lastRun.score != null ? (
                          <span
                            className={`ai-decision-badge ${
                              toNumber(lastRun.score) >= 80
                                ? "positive"
                                : toNumber(lastRun.score) >= 50
                                  ? "warning"
                                  : "danger"
                            }`}
                          >
                            %
                            {toNumber(lastRun.score).toLocaleString("tr-TR", {
                              maximumFractionDigits: 0,
                            })}
                            {lastRun.total_cases != null &&
                              ` (${lastRun.passed_cases ?? 0}/${lastRun.total_cases})`}
                          </span>
                        ) : (
                          <span className="ai-note">Henüz yok</span>
                        )}
                      </td>
                      <td>{formatAiDate(lastRun.started_at ?? null)}</td>
                      <td>
                        <Link
                          className="subtle-button"
                          href={`/app/ai-chats/evaluations/${evaluation.id}`}
                        >
                          Aç
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
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
            <h2>Yeni değerlendirme seti</h2>
            <label>
              Ad
              <input name="name" required maxLength={120} autoFocus />
            </label>
            <label>
              Açıklama
              <textarea name="description" maxLength={500} />
            </label>
            <label>
              Varsayılan ajan (isteğe bağlı)
              <select name="agentId" defaultValue="">
                <option value="">Seçilmedi</option>
                {agents.map((agent) => (
                  <option value={agent.id} key={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </select>
            </label>
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
    </AppFrame>
  );
}
