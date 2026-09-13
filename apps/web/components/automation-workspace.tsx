"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Activity,
  FilePenLine,
  PauseCircle,
  Play,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Workflow,
  Zap,
} from "lucide-react";
import { AppFrame } from "./app-frame";
import { apiJson } from "../lib/api";
import {
  filterAutomationRules,
  summarizeAutomationRules,
  type AutomationRuleSummary,
  type AutomationStatusFilter,
} from "./automation-management";

function statusLabel(status: string) {
  if (status === "active") return "Aktif";
  if (status === "paused") return "Duraklatıldı";
  return "Taslak";
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("tr-TR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function AutomationWorkspace() {
  const [rules, setRules] = useState<AutomationRuleSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] =
    useState<AutomationStatusFilter>("all");
  const [publishingId, setPublishingId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] =
    useState<AutomationRuleSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await apiJson<{ data: AutomationRuleSummary[] }>(
        "/api/v1/automations",
      );
      setRules(result.data ?? []);
      setError("");
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Otomasyonlar yüklenemedi.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const summary = useMemo(() => summarizeAutomationRules(rules), [rules]);
  const visibleRules = useMemo(
    () => filterAutomationRules(rules, query, statusFilter),
    [query, rules, statusFilter],
  );

  async function publish(rule: AutomationRuleSummary) {
    if (publishingId) return;
    setPublishingId(rule.id);
    setError("");
    try {
      await apiJson(`/api/v1/automations/${rule.id}/publish`, {
        method: "POST",
      });
      setNotice(`“${rule.name}” yayınlandı.`);
      await load();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Otomasyon yayınlanamadı.",
      );
    } finally {
      setPublishingId(null);
    }
  }

  async function remove() {
    if (!pendingDelete || deleting) return;
    setDeleting(true);
    setError("");
    try {
      await apiJson(`/api/v1/automations/${pendingDelete.id}`, {
        method: "DELETE",
      });
      setRules((current) =>
        current.filter((rule) => rule.id !== pendingDelete.id),
      );
      setNotice(`“${pendingDelete.name}” silindi. Çalışma geçmişi korundu.`);
      setPendingDelete(null);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Otomasyon silinemedi.",
      );
    } finally {
      setDeleting(false);
    }
  }

  return (
    <AppFrame
      title="Otomasyonlar"
      subtitle="Mesaj akışlarınızı oluşturun, yönetin ve çalışma sonuçlarını izleyin."
      actions={
        <Link
          className="primary-button automation-create-button"
          href="/app/automations/new"
        >
          <Plus size={17} /> Otomasyon ekle
        </Link>
      }
    >
      {notice && (
        <div className="success-banner automation-feedback" role="status">
          {notice}
          <button type="button" onClick={() => setNotice("")}>
            Kapat
          </button>
        </div>
      )}
      {error && (
        <div className="error-banner automation-feedback" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => void load()}>
            <RefreshCw size={14} /> Yeniden dene
          </button>
        </div>
      )}

      <section className="automation-summary-grid" aria-label="Otomasyon özeti">
        <article>
          <span className="automation-summary-icon neutral">
            <Workflow size={19} />
          </span>
          <div>
            <strong>{summary.total}</strong>
            <small>Toplam otomasyon</small>
          </div>
        </article>
        <article>
          <span className="automation-summary-icon active">
            <Zap size={19} />
          </span>
          <div>
            <strong>{summary.active}</strong>
            <small>Aktif</small>
          </div>
        </article>
        <article>
          <span className="automation-summary-icon draft">
            <FilePenLine size={19} />
          </span>
          <div>
            <strong>{summary.draft}</strong>
            <small>Taslak</small>
          </div>
        </article>
        <article>
          <span className="automation-summary-icon paused">
            <PauseCircle size={19} />
          </span>
          <div>
            <strong>{summary.paused}</strong>
            <small>Duraklatıldı</small>
          </div>
        </article>
      </section>

      <section className="automation-management-card">
        <header className="automation-list-toolbar">
          <div>
            <h2>Otomasyon listesi</h2>
            <p>Kaydedilen akışlar ve güncel çalışma durumları.</p>
          </div>
          <div className="automation-list-filters">
            <label className="automation-search-field">
              <Search size={16} aria-hidden="true" />
              <span className="sr-only">Otomasyonlarda ara</span>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Otomasyonlarda ara"
              />
            </label>
            <label>
              <span className="sr-only">Duruma göre filtrele</span>
              <select
                aria-label="Duruma göre filtrele"
                value={statusFilter}
                onChange={(event) =>
                  setStatusFilter(event.target.value as AutomationStatusFilter)
                }
              >
                <option value="all">Tüm durumlar</option>
                <option value="active">Aktif</option>
                <option value="draft">Taslak</option>
                <option value="paused">Duraklatıldı</option>
              </select>
            </label>
          </div>
        </header>

        {loading ? (
          <div className="automation-list-loading" aria-label="Yükleniyor">
            <span />
            <span />
            <span />
          </div>
        ) : rules.length === 0 ? (
          <div className="automation-empty-state">
            <span>
              <Workflow size={28} />
            </span>
            <h2>İlk otomasyonunuzu oluşturun</h2>
            <p>
              Gelen mesajları analiz eden ve ekibinizin iş yükünü azaltan bir
              akış tasarlayın.
            </p>
            <Link className="primary-button" href="/app/automations/new">
              <Plus size={16} /> Otomasyon ekle
            </Link>
          </div>
        ) : visibleRules.length === 0 ? (
          <div className="automation-empty-state compact">
            <Search size={25} />
            <h2>Eşleşen otomasyon bulunamadı</h2>
            <p>Arama metnini veya durum filtresini değiştirin.</p>
          </div>
        ) : (
          <div className="automation-rule-list">
            {visibleRules.map((rule) => (
              <article className="automation-rule-row" key={rule.id}>
                <div className="automation-rule-identity">
                  <span className={`automation-rule-mark ${rule.status}`}>
                    <Workflow size={18} />
                  </span>
                  <div>
                    <strong>{rule.name}</strong>
                    <p>
                      {rule.description || "Automation Studio mesaj akışı"}
                    </p>
                  </div>
                </div>
                <div className="automation-rule-updated">
                  <small>Son düzenleme</small>
                  <strong>{formatDate(rule.updated_at)}</strong>
                </div>
                <span className={`automation-status-badge ${rule.status}`}>
                  {statusLabel(rule.status)}
                </span>
                <div className="automation-rule-actions">
                  {rule.status !== "active" && (
                    <button
                      type="button"
                      className="subtle-button"
                      onClick={() => void publish(rule)}
                      disabled={publishingId === rule.id}
                    >
                      <Play size={14} />
                      {publishingId === rule.id ? "Yayınlanıyor" : "Yayınla"}
                    </button>
                  )}
                  <Link
                    className="subtle-button"
                    href={`/app/automations/${rule.id}`}
                  >
                    <FilePenLine size={14} /> Düzenle
                  </Link>
                  <Link
                    className="subtle-button icon-only"
                    href={`/app/automations/${rule.id}/runs`}
                    aria-label={`${rule.name} çalışmalarını görüntüle`}
                    title="Çalışmalar"
                  >
                    <Activity size={15} />
                  </Link>
                  <button
                    type="button"
                    className="subtle-button icon-only danger"
                    aria-label={`${rule.name} otomasyonunu sil`}
                    title="Sil"
                    onClick={() => setPendingDelete(rule)}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      {pendingDelete && (
        <div
          className="automation-modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !deleting)
              setPendingDelete(null);
          }}
        >
          <section
            className="automation-confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="automation-delete-title"
            aria-describedby="automation-delete-description"
          >
            <span className="automation-delete-icon">
              <Trash2 size={20} />
            </span>
            <h2 id="automation-delete-title">Otomasyon silinsin mi?</h2>
            <p id="automation-delete-description">
              <strong>{pendingDelete.name}</strong> artık çalışmayacak ve
              listeden kaldırılacak. Sürüm ve çalışma geçmişi korunacaktır.
            </p>
            <div className="automation-confirm-actions">
              <button
                type="button"
                className="subtle-button"
                onClick={() => setPendingDelete(null)}
                disabled={deleting}
                autoFocus
              >
                Vazgeç
              </button>
              <button
                type="button"
                className="danger-button"
                onClick={() => void remove()}
                disabled={deleting}
              >
                <Trash2 size={15} />
                {deleting ? "Siliniyor" : "Otomasyonu sil"}
              </button>
            </div>
          </section>
        </div>
      )}
    </AppFrame>
  );
}
