"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Activity,
  Archive,
  Bot,
  CircleDollarSign,
  PauseCircle,
  Play,
  Plus,
  RefreshCw,
  Rocket,
  Search,
  Settings2,
  X,
  Zap,
} from "lucide-react";
import { AppFrame } from "./app-frame";
import { AiNav } from "./ai-nav";
import { apiJson } from "../lib/api";
import {
  agentModeLabel,
  agentStatusLabel,
  filterAiAgents,
  formatCount,
  formatUsd,
  summarizeAiAgents,
  type AiAgentStatusFilter,
  type AiAgentSummary,
} from "./ai-management";

export function AiAgentsWorkspace() {
  const router = useRouter();
  const [agents, setAgents] = useState<AiAgentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<AiAgentStatusFilter>("all");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingArchive, setPendingArchive] = useState<AiAgentSummary | null>(
    null,
  );
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await apiJson<{ data: AiAgentSummary[] }>(
        "/api/v1/ai/agents",
      );
      setAgents(result.data ?? []);
      setError("");
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "AI ajanları yüklenemedi.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const summary = useMemo(() => summarizeAiAgents(agents), [agents]);
  const visibleAgents = useMemo(
    () => filterAiAgents(agents, query, statusFilter),
    [agents, query, statusFilter],
  );

  async function publish(agent: AiAgentSummary) {
    if (busyId) return;
    setBusyId(agent.id);
    setError("");
    try {
      await apiJson(`/api/v1/ai/agents/${agent.id}/publish`, {
        method: "POST",
      });
      setNotice(`“${agent.name}” yayınlandı.`);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Ajan yayınlanamadı.");
    } finally {
      setBusyId(null);
    }
  }

  async function setStatus(
    agent: AiAgentSummary,
    status: "active" | "paused" | "archived",
  ) {
    if (busyId) return;
    setBusyId(agent.id);
    setError("");
    try {
      await apiJson(`/api/v1/ai/agents/${agent.id}/status`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status }),
      });
      setNotice(
        status === "active"
          ? `“${agent.name}” etkinleştirildi.`
          : status === "paused"
            ? `“${agent.name}” duraklatıldı.`
            : `“${agent.name}” arşivlendi.`,
      );
      setPendingArchive(null);
      await load();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Ajan durumu güncellenemedi.",
      );
    } finally {
      setBusyId(null);
    }
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (creating) return;
    const form = new FormData(event.currentTarget);
    setCreating(true);
    setError("");
    try {
      const result = await apiJson<{ data: { id: string } }>(
        "/api/v1/ai/agents",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: form.get("name"),
            description: form.get("description") || undefined,
          }),
        },
      );
      setCreateOpen(false);
      router.push(`/app/ai-chats/agents/${result.data.id}`);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Ajan oluşturulamadı.",
      );
    } finally {
      setCreating(false);
    }
  }

  return (
    <AppFrame
      title="AI Ajanları"
      subtitle="Yapay zeka ajanlarını oluşturun, yapılandırın ve kanallara bağlayın."
      actions={
        <button
          type="button"
          className="primary-button compact-button"
          onClick={() => setCreateOpen(true)}
        >
          <Plus size={16} aria-hidden="true" /> Ajan oluştur
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

      <section className="ai-kpi-grid" aria-label="AI ajan özeti">
        <article className="ai-kpi-card">
          <span className="ai-kpi-icon" aria-hidden="true">
            <Bot size={19} />
          </span>
          <div>
            <strong>{summary.total}</strong>
            <small>Toplam ajan</small>
          </div>
        </article>
        <article className="ai-kpi-card">
          <span className="ai-kpi-icon positive" aria-hidden="true">
            <Zap size={19} />
          </span>
          <div>
            <strong>{summary.active}</strong>
            <small>Aktif ajan</small>
          </div>
        </article>
        <article className="ai-kpi-card">
          <span className="ai-kpi-icon" aria-hidden="true">
            <Activity size={19} />
          </span>
          <div>
            <strong>{formatCount(summary.runsToday)}</strong>
            <small>Bugünkü çalışma</small>
          </div>
        </article>
        <article className="ai-kpi-card">
          <span className="ai-kpi-icon warning" aria-hidden="true">
            <CircleDollarSign size={19} />
          </span>
          <div>
            <strong>{formatUsd(summary.costToday)}</strong>
            <small>Bugünkü maliyet</small>
          </div>
        </article>
      </section>

      <section className="stack-card ai-panel">
        <header className="ai-panel-header">
          <div>
            <h2>Ajan listesi</h2>
            <p className="ai-note">
              Yayın durumu, mod ve günlük kullanım bir arada.
            </p>
          </div>
          <div className="ai-toolbar">
            <label className="ai-search">
              <Search size={16} aria-hidden="true" />
              <span className="sr-only">Ajanlarda ara</span>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Ajanlarda ara"
              />
            </label>
            <label>
              <span className="sr-only">Duruma göre filtrele</span>
              <select
                aria-label="Duruma göre filtrele"
                value={statusFilter}
                onChange={(event) =>
                  setStatusFilter(event.target.value as AiAgentStatusFilter)
                }
              >
                <option value="all">Tüm durumlar</option>
                <option value="active">Aktif</option>
                <option value="draft">Taslak</option>
                <option value="paused">Duraklatıldı</option>
                <option value="archived">Arşiv</option>
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
        ) : agents.length === 0 ? (
          <div className="empty-state">
            <Bot aria-hidden="true" />
            <h2>İlk AI ajanınızı oluşturun</h2>
            <p>
              Müşteri mesajlarını anlayan, bilgi tabanınızdan yararlanan ve
              gerektiğinde ekibinize devreden bir ajan tanımlayın.
            </p>
            <button
              type="button"
              className="primary-button"
              onClick={() => setCreateOpen(true)}
            >
              <Plus size={16} aria-hidden="true" /> Ajan oluştur
            </button>
          </div>
        ) : visibleAgents.length === 0 ? (
          <div className="empty-state">
            <Search aria-hidden="true" />
            <h2>Eşleşen ajan bulunamadı</h2>
            <p>Arama metnini veya durum filtresini değiştirin.</p>
          </div>
        ) : (
          <div className="table-card ai-table-scroll ai-borderless">
            <table>
              <caption className="sr-only">AI ajanları</caption>
              <thead>
                <tr>
                  <th>Ajan</th>
                  <th>Durum</th>
                  <th>Mod</th>
                  <th>Model</th>
                  <th>Sürüm</th>
                  <th>Kanal</th>
                  <th>Bugün</th>
                  <th>İşlemler</th>
                </tr>
              </thead>
              <tbody>
                {visibleAgents.map((agent) => (
                  <tr key={agent.id}>
                    <td>
                      <Link
                        className="ai-row-title"
                        href={`/app/ai-chats/agents/${agent.id}`}
                      >
                        <strong>{agent.name}</strong>
                        {agent.description && <small>{agent.description}</small>}
                      </Link>
                    </td>
                    <td>
                      <span
                        className={`automation-status-badge ${agent.status}`}
                      >
                        {agentStatusLabel(agent.status)}
                      </span>
                    </td>
                    <td>{agentModeLabel(agent.published_mode)}</td>
                    <td>
                      <code className="ai-model-code">
                        {agent.published_model ?? "—"}
                      </code>
                    </td>
                    <td>
                      {agent.published_version != null
                        ? `v${agent.published_version}`
                        : "Yayın yok"}
                      {agent.draft_version != null && (
                        <small className="ai-draft-hint">
                          Taslak v{agent.draft_version}
                        </small>
                      )}
                    </td>
                    <td>{formatCount(agent.channel_count)}</td>
                    <td>
                      {formatCount(agent.runs_today)} çalışma
                      <small className="ai-draft-hint">
                        {formatUsd(agent.cost_today)}
                      </small>
                    </td>
                    <td>
                      <div className="ai-row-actions">
                        {agent.draft_version != null && (
                          <button
                            type="button"
                            className="subtle-button"
                            onClick={() => void publish(agent)}
                            disabled={busyId === agent.id}
                          >
                            <Rocket size={14} aria-hidden="true" />
                            {busyId === agent.id ? "Yayınlanıyor" : "Yayınla"}
                          </button>
                        )}
                        {agent.status === "active" ? (
                          <button
                            type="button"
                            className="subtle-button icon-only"
                            aria-label={`${agent.name} ajanını duraklat`}
                            title="Duraklat"
                            onClick={() => void setStatus(agent, "paused")}
                            disabled={busyId === agent.id}
                          >
                            <PauseCircle size={15} aria-hidden="true" />
                          </button>
                        ) : agent.status !== "archived" ? (
                          <button
                            type="button"
                            className="subtle-button icon-only"
                            aria-label={`${agent.name} ajanını etkinleştir`}
                            title="Etkinleştir"
                            onClick={() => void setStatus(agent, "active")}
                            disabled={busyId === agent.id}
                          >
                            <Play size={15} aria-hidden="true" />
                          </button>
                        ) : null}
                        <Link
                          className="subtle-button icon-only"
                          href={`/app/ai-chats/agents/${agent.id}`}
                          aria-label={`${agent.name} ayarlarını aç`}
                          title="Yapılandır"
                        >
                          <Settings2 size={15} aria-hidden="true" />
                        </Link>
                        {agent.status !== "archived" && (
                          <button
                            type="button"
                            className="subtle-button icon-only danger"
                            aria-label={`${agent.name} ajanını arşivle`}
                            title="Arşivle"
                            onClick={() => setPendingArchive(agent)}
                            disabled={busyId === agent.id}
                          >
                            <Archive size={15} aria-hidden="true" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

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
            <h2>Yeni AI ajanı</h2>
            <p className="ai-note">
              Ajanı oluşturduktan sonra talimatlar, bilgi tabanı ve kanallar
              detay sayfasından yapılandırılır.
            </p>
            <label>
              Ajan adı
              <input name="name" required maxLength={120} autoFocus />
            </label>
            <label>
              Açıklama
              <textarea
                name="description"
                maxLength={500}
                placeholder="Örn. WhatsApp destek hattı için satış asistanı"
              />
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

      {pendingArchive && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setPendingArchive(null);
          }}
        >
          <section
            className="modal-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ai-archive-title"
          >
            <h2 id="ai-archive-title">Ajan arşivlensin mi?</h2>
            <p>
              <strong>{pendingArchive.name}</strong> yanıt üretmeyi durduracak
              ve listeden kaldırılacak. Çalışma geçmişi korunur.
            </p>
            <div className="modal-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => setPendingArchive(null)}
                autoFocus
              >
                Vazgeç
              </button>
              <button
                type="button"
                className="primary-button ai-danger-button"
                onClick={() => void setStatus(pendingArchive, "archived")}
                disabled={busyId === pendingArchive.id}
              >
                <Archive size={15} aria-hidden="true" />
                {busyId === pendingArchive.id ? "Arşivleniyor…" : "Arşivle"}
              </button>
            </div>
          </section>
        </div>
      )}
    </AppFrame>
  );
}
