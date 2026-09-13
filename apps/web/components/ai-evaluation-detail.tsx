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
  CheckCircle2,
  ClipboardCheck,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Trash2,
  X,
  XCircle,
} from "lucide-react";
import { AppFrame } from "./app-frame";
import { AiNav } from "./ai-nav";
import { apiJson } from "../lib/api";
import {
  formatAiDate,
  formatCount,
  formatLatency,
  formatUsd,
  parseMaybeJson,
  splitCommaList,
  toNumber,
  type AiAgentSummary,
} from "./ai-management";

type EvaluationCase = {
  id: string;
  name: string;
  position: number;
  input: unknown;
  expectations: unknown;
  created_at: string;
};

type CaseExpectations = {
  mustContain?: string[];
  mustNotContain?: string[];
  expectHandoff?: boolean;
  language?: string;
  minConfidence?: number;
};

type EvaluationRunResult = {
  evaluationRunId: string;
  score: number | string;
  passed: number;
  total: number;
  agentVersion: number;
  results: Array<{
    caseId: string;
    name: string;
    pass: boolean;
    failures: string[];
    text: string;
    confidence: number | string | null;
    requiresHuman: boolean;
    latencyMs: number;
    runId: string;
  }>;
};

type EvaluationRunHistory = {
  id: string;
  status: string;
  score: number | string | null;
  passed_cases: number | null;
  total_cases: number | null;
  total_cost_usd: number | string | null;
  started_at: string | null;
  completed_at: string | null;
  agent_version: number | null;
  agent_name: string | null;
};

type MessageDraft = { role: "customer" | "business"; text: string };

export function AiEvaluationDetail({ evaluationId }: { evaluationId: string }) {
  const [cases, setCases] = useState<EvaluationCase[]>([]);
  const [history, setHistory] = useState<EvaluationRunHistory[]>([]);
  const [agents, setAgents] = useState<AiAgentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [messages, setMessages] = useState<MessageDraft[]>([
    { role: "customer", text: "" },
  ]);
  const [runAgentId, setRunAgentId] = useState("");
  const [runUseDraft, setRunUseDraft] = useState(true);
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState<EvaluationRunResult | null>(null);
  const [pendingDelete, setPendingDelete] = useState<EvaluationCase | null>(
    null,
  );
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [caseResult, historyResult] = await Promise.all([
        apiJson<{ data: EvaluationCase[] }>(
          `/api/v1/ai/evaluations/${evaluationId}/cases`,
        ),
        apiJson<{ data: EvaluationRunHistory[] }>(
          `/api/v1/ai/evaluations/${evaluationId}/runs`,
        ).catch(() => ({ data: [] as EvaluationRunHistory[] })),
      ]);
      setCases(caseResult.data ?? []);
      setHistory(historyResult.data ?? []);
      setError("");
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Değerlendirme seti yüklenemedi.",
      );
    } finally {
      setLoading(false);
    }
  }, [evaluationId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    void apiJson<{ data: AiAgentSummary[] }>("/api/v1/ai/agents")
      .then((result) => {
        const list = (result.data ?? []).filter(
          (agent) => agent.status !== "archived",
        );
        setAgents(list);
        if (list.length > 0)
          setRunAgentId((current) => current || list[0]!.id);
      })
      .catch(() => setAgents([]));
  }, []);

  async function addCase(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    const form = new FormData(event.currentTarget);
    const validMessages = messages.filter((message) => message.text.trim());
    if (validMessages.length === 0) {
      setError("Senaryo için en az bir mesaj girin.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const expectations: CaseExpectations = {};
      const mustContain = splitCommaList(String(form.get("mustContain") ?? ""));
      const mustNotContain = splitCommaList(
        String(form.get("mustNotContain") ?? ""),
      );
      if (mustContain.length) expectations.mustContain = mustContain;
      if (mustNotContain.length) expectations.mustNotContain = mustNotContain;
      if (form.get("expectHandoff")) expectations.expectHandoff = true;
      if (form.get("language"))
        expectations.language = String(form.get("language"));
      if (form.get("minConfidence"))
        expectations.minConfidence = toNumber(form.get("minConfidence"));
      await apiJson(`/api/v1/ai/evaluations/${evaluationId}/cases`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: form.get("name"),
          messages: validMessages,
          expectations,
        }),
      });
      setAddOpen(false);
      setMessages([{ role: "customer", text: "" }]);
      setNotice("Senaryo eklendi.");
      await load();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Senaryo eklenemedi.",
      );
    } finally {
      setSaving(false);
    }
  }

  async function removeCase() {
    if (!pendingDelete || deleting) return;
    setDeleting(true);
    setError("");
    try {
      await apiJson(`/api/v1/ai/evaluations/cases/${pendingDelete.id}`, {
        method: "DELETE",
      });
      setNotice(`“${pendingDelete.name}” senaryosu silindi.`);
      setPendingDelete(null);
      await load();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Senaryo silinemedi.",
      );
    } finally {
      setDeleting(false);
    }
  }

  async function runEvaluation() {
    if (running || !runAgentId) return;
    setRunning(true);
    setError("");
    setRunResult(null);
    try {
      const result = await apiJson<{ data: EvaluationRunResult }>(
        `/api/v1/ai/evaluations/${evaluationId}/run`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ agentId: runAgentId, useDraft: runUseDraft }),
        },
      );
      setRunResult(result.data);
      setNotice("Değerlendirme tamamlandı.");
      await load();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Değerlendirme çalıştırılamadı.",
      );
    } finally {
      setRunning(false);
    }
  }

  function expectationSummary(raw: unknown): string {
    const expectations = parseMaybeJson<CaseExpectations>(raw, {});
    const parts: string[] = [];
    if (expectations.mustContain?.length)
      parts.push(`İçermeli: ${expectations.mustContain.join(", ")}`);
    if (expectations.mustNotContain?.length)
      parts.push(`İçermemeli: ${expectations.mustNotContain.join(", ")}`);
    if (expectations.expectHandoff) parts.push("İnsana devir beklenir");
    if (expectations.language) parts.push(`Dil: ${expectations.language}`);
    if (expectations.minConfidence != null)
      parts.push(`Min. güven: ${expectations.minConfidence}`);
    return parts.join(" · ") || "Beklenti tanımlanmadı";
  }

  return (
    <AppFrame
      title="Değerlendirme seti"
      subtitle="Senaryoları yönetin, ajan üzerinde çalıştırın ve sonuçları karşılaştırın."
      actions={
        <div className="inline-actions">
          <Link className="subtle-button" href="/app/ai-chats/evaluations">
            <ArrowLeft size={15} aria-hidden="true" /> Setlere dön
          </Link>
          <button
            type="button"
            className="primary-button compact-button"
            onClick={() => setAddOpen(true)}
          >
            <Plus size={16} aria-hidden="true" /> Senaryo ekle
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

      <section className="stack-card ai-detail-card">
        <h2>Değerlendirmeyi çalıştır</h2>
        <div className="ai-form-grid">
          <label>
            Ajan
            <select
              value={runAgentId}
              onChange={(event) => setRunAgentId(event.target.value)}
            >
              {agents.length === 0 && <option value="">Ajan bulunamadı</option>}
              {agents.map((agent) => (
                <option value={agent.id} key={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </label>
          <label className="ai-checkbox-row ai-checkbox-align">
            <input
              type="checkbox"
              checked={runUseDraft}
              onChange={(event) => setRunUseDraft(event.target.checked)}
            />
            <span>Taslak sürümü kullan</span>
          </label>
          <div className="ai-run-action">
            <button
              type="button"
              className="primary-button"
              onClick={() => void runEvaluation()}
              disabled={running || !runAgentId || cases.length === 0}
            >
              {running ? (
                <>
                  <Loader2 size={15} className="ai-spin" aria-hidden="true" />{" "}
                  Çalıştırılıyor…
                </>
              ) : (
                <>
                  <Play size={15} aria-hidden="true" /> Değerlendirmeyi çalıştır
                </>
              )}
            </button>
          </div>
        </div>
        {running && (
          <p className="ai-note" role="status">
            Tüm senaryolar sırayla çalıştırılıyor; bu işlem bir dakikaya kadar
            sürebilir.
          </p>
        )}
        {runResult && (
          <div className="ai-run-result">
            <p>
              <strong>
                Skor: %
                {toNumber(runResult.score).toLocaleString("tr-TR", {
                  maximumFractionDigits: 0,
                })}
              </strong>{" "}
              — {runResult.passed}/{runResult.total} senaryo başarılı (v
              {runResult.agentVersion})
            </p>
            <div className="table-card ai-table-scroll ai-borderless">
              <table>
                <caption className="sr-only">Değerlendirme sonuçları</caption>
                <thead>
                  <tr>
                    <th>Senaryo</th>
                    <th>Sonuç</th>
                    <th>Yanıt</th>
                    <th>Güven</th>
                    <th>Gecikme</th>
                  </tr>
                </thead>
                <tbody>
                  {runResult.results.map((result) => (
                    <tr key={result.caseId}>
                      <td>
                        <strong>{result.name}</strong>
                      </td>
                      <td>
                        {result.pass ? (
                          <span className="ai-decision-badge positive">
                            <CheckCircle2 size={13} aria-hidden="true" /> Başarılı
                          </span>
                        ) : (
                          <>
                            <span className="ai-decision-badge danger">
                              <XCircle size={13} aria-hidden="true" /> Başarısız
                            </span>
                            {result.failures.length > 0 && (
                              <small className="ai-error-hint">
                                {result.failures.join("; ")}
                              </small>
                            )}
                          </>
                        )}
                      </td>
                      <td className="ai-cell-clamp">{result.text}</td>
                      <td>
                        {result.confidence != null
                          ? toNumber(result.confidence).toLocaleString(
                              "tr-TR",
                              { maximumFractionDigits: 2 },
                            )
                          : "—"}
                      </td>
                      <td>{formatLatency(result.latencyMs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>

      <section className="stack-card ai-panel">
        <header className="ai-panel-header">
          <div>
            <h2>Senaryolar</h2>
            <p className="ai-note">{cases.length} senaryo tanımlı.</p>
          </div>
        </header>
        {loading ? (
          <div className="ai-skeleton-list" aria-label="Yükleniyor">
            <span className="skeleton-block" />
            <span className="skeleton-block" />
          </div>
        ) : cases.length === 0 ? (
          <div className="empty-state">
            <ClipboardCheck aria-hidden="true" />
            <h2>Henüz senaryo yok</h2>
            <p>
              Sık gelen bir müşteri sorusunu ve beklediğiniz yanıt ölçütlerini
              senaryo olarak ekleyin.
            </p>
            <button
              type="button"
              className="primary-button"
              onClick={() => setAddOpen(true)}
            >
              <Plus size={16} aria-hidden="true" /> Senaryo ekle
            </button>
          </div>
        ) : (
          <div className="ai-case-list">
            {cases.map((testCase) => {
              const input = parseMaybeJson<MessageDraft[]>(testCase.input, []);
              return (
                <article className="ai-case-row" key={testCase.id}>
                  <div>
                    <strong>{testCase.name}</strong>
                    <p className="ai-note">
                      {input
                        .map(
                          (message) =>
                            `${message.role === "customer" ? "Müşteri" : "İşletme"}: ${message.text}`,
                        )
                        .join(" → ")}
                    </p>
                    <p className="ai-note">
                      {expectationSummary(testCase.expectations)}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="subtle-button icon-only danger"
                    aria-label={`${testCase.name} senaryosunu sil`}
                    title="Sil"
                    onClick={() => setPendingDelete(testCase)}
                  >
                    <Trash2 size={15} aria-hidden="true" />
                  </button>
                </article>
              );
            })}
          </div>
        )}
      </section>

      <section className="stack-card ai-panel">
        <header className="ai-panel-header">
          <div>
            <h2>Çalıştırma geçmişi</h2>
          </div>
        </header>
        {history.length === 0 ? (
          <p className="ai-note ai-panel-note">Henüz çalıştırma yapılmadı.</p>
        ) : (
          <div className="table-card ai-table-scroll ai-borderless">
            <table>
              <caption className="sr-only">Çalıştırma geçmişi</caption>
              <thead>
                <tr>
                  <th>Tarih</th>
                  <th>Ajan</th>
                  <th>Skor</th>
                  <th>Maliyet</th>
                  <th>Durum</th>
                </tr>
              </thead>
              <tbody>
                {history.map((run) => (
                  <tr key={run.id}>
                    <td>{formatAiDate(run.started_at)}</td>
                    <td>
                      {run.agent_name ?? "—"}
                      {run.agent_version != null && (
                        <small className="ai-draft-hint">
                          v{run.agent_version}
                        </small>
                      )}
                    </td>
                    <td>
                      {run.score != null
                        ? `%${toNumber(run.score).toLocaleString("tr-TR", { maximumFractionDigits: 0 })} (${formatCount(run.passed_cases)}/${formatCount(run.total_cases)})`
                        : "—"}
                    </td>
                    <td>{formatUsd(run.total_cost_usd)}</td>
                    <td>
                      <span
                        className={`ai-decision-badge ${
                          run.status === "completed"
                            ? "positive"
                            : run.status === "failed"
                              ? "danger"
                              : "neutral"
                        }`}
                      >
                        {run.status === "completed"
                          ? "Tamamlandı"
                          : run.status === "failed"
                            ? "Hata"
                            : run.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {addOpen && (
        <div className="modal-backdrop">
          <form className="modal-card ai-modal-wide" onSubmit={addCase}>
            <button
              type="button"
              className="modal-close"
              aria-label="Pencereyi kapat"
              onClick={() => setAddOpen(false)}
            >
              <X size={18} aria-hidden="true" />
            </button>
            <h2>Yeni senaryo</h2>
            <label>
              Senaryo adı
              <input name="name" required maxLength={160} autoFocus />
            </label>
            <span className="ai-list-label">Konuşma mesajları</span>
            <div className="ai-message-builder">
              {messages.map((message, index) => (
                <div className="ai-message-builder-row" key={index}>
                  <select
                    aria-label={`${index + 1}. mesaj rolü`}
                    value={message.role}
                    onChange={(event) =>
                      setMessages((current) =>
                        current.map((item, itemIndex) =>
                          itemIndex === index
                            ? {
                                ...item,
                                role: event.target.value as MessageDraft["role"],
                              }
                            : item,
                        ),
                      )
                    }
                  >
                    <option value="customer">Müşteri</option>
                    <option value="business">İşletme</option>
                  </select>
                  <input
                    aria-label={`${index + 1}. mesaj metni`}
                    value={message.text}
                    placeholder="Mesaj metni"
                    onChange={(event) =>
                      setMessages((current) =>
                        current.map((item, itemIndex) =>
                          itemIndex === index
                            ? { ...item, text: event.target.value }
                            : item,
                        ),
                      )
                    }
                  />
                  <button
                    type="button"
                    className="subtle-button icon-only danger"
                    aria-label={`${index + 1}. mesajı kaldır`}
                    disabled={messages.length === 1}
                    onClick={() =>
                      setMessages((current) =>
                        current.filter((_, itemIndex) => itemIndex !== index),
                      )
                    }
                  >
                    <Trash2 size={14} aria-hidden="true" />
                  </button>
                </div>
              ))}
              <div>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() =>
                    setMessages((current) => [
                      ...current,
                      { role: "customer", text: "" },
                    ])
                  }
                >
                  <Plus size={14} aria-hidden="true" /> Mesaj ekle
                </button>
              </div>
            </div>
            <div className="form-row">
              <label>
                Yanıt şunları içermeli (virgülle)
                <input name="mustContain" placeholder="iade, 14 gün" />
              </label>
              <label>
                Yanıt şunları içermemeli (virgülle)
                <input name="mustNotContain" placeholder="garanti edilir" />
              </label>
            </div>
            <div className="form-row">
              <label>
                Beklenen dil
                <input name="language" maxLength={10} placeholder="tr" />
              </label>
              <label>
                Minimum güven (0-1)
                <input
                  name="minConfidence"
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                />
              </label>
            </div>
            <label className="ai-checkbox-row">
              <input type="checkbox" name="expectHandoff" />
              <span>Bu senaryoda insana devir beklenir</span>
            </label>
            <div className="modal-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => setAddOpen(false)}
              >
                Vazgeç
              </button>
              <button className="primary-button" disabled={saving}>
                {saving ? "Ekleniyor…" : "Senaryoyu ekle"}
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
            aria-labelledby="ai-case-delete-title"
          >
            <h2 id="ai-case-delete-title">Senaryo silinsin mi?</h2>
            <p>
              <strong>{pendingDelete.name}</strong> senaryosu setten
              kaldırılacak.
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
                onClick={() => void removeCase()}
                disabled={deleting}
              >
                <Trash2 size={15} aria-hidden="true" />
                {deleting ? "Siliniyor…" : "Sil"}
              </button>
            </div>
          </section>
        </div>
      )}
    </AppFrame>
  );
}
