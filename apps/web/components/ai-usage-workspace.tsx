"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  CircleDollarSign,
  RefreshCw,
  Send,
  Users,
} from "lucide-react";
import { AppFrame } from "./app-frame";
import { AiNav } from "./ai-nav";
import { apiJson } from "../lib/api";
import {
  formatCount,
  formatPercent,
  formatUsd,
  summarizeAiUsage,
  toNumber,
  type AiUsageDay,
} from "./ai-management";

type AgentUsageRow = {
  agent_id: string;
  agent_name: string;
  runs: number | string | null;
  auto_sent: number | string | null;
  handoffs: number | string | null;
  total_cost_usd: number | string | null;
};

type UsageData = {
  daily: AiUsageDay[];
  byAgent: AgentUsageRow[];
};

const DAY_OPTIONS = [
  { value: 7, label: "Son 7 gün" },
  { value: 30, label: "Son 30 gün" },
  { value: 90, label: "Son 90 gün" },
];

export function AiUsageWorkspace() {
  const [data, setData] = useState<UsageData | null>(null);
  const [days, setDays] = useState(30);
  const [metric, setMetric] = useState<"cost" | "runs">("cost");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await apiJson<{ data: UsageData }>(
        `/api/v1/ai/usage?days=${days}`,
      );
      setData(result.data);
      setError("");
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Kullanım verileri yüklenemedi.",
      );
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const summary = useMemo(
    () => summarizeAiUsage(data?.daily ?? []),
    [data],
  );

  const chart = useMemo(() => {
    const daily = data?.daily ?? [];
    const values = daily.map((day) =>
      metric === "cost" ? toNumber(day.total_cost_usd) : toNumber(day.runs),
    );
    const max = Math.max(...values, 0);
    return { daily, values, max };
  }, [data, metric]);

  return (
    <AppFrame
      title="Kullanım"
      subtitle="AI çalışmalarının hacmi, otomasyon oranı ve maliyet dağılımı."
      actions={
        <label>
          <span className="sr-only">Dönem seçin</span>
          <select
            className="ai-header-select"
            aria-label="Dönem seçin"
            value={days}
            onChange={(event) => setDays(Number(event.target.value))}
          >
            {DAY_OPTIONS.map((option) => (
              <option value={option.value} key={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
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

      {loading ? (
        <div className="ai-skeleton-list" aria-label="Yükleniyor">
          <span className="skeleton-block" />
          <span className="skeleton-block" />
        </div>
      ) : (
        <>
          <section className="ai-kpi-grid" aria-label="Kullanım özeti">
            <article className="ai-kpi-card">
              <span className="ai-kpi-icon" aria-hidden="true">
                <Activity size={19} />
              </span>
              <div>
                <strong>{formatCount(summary.runs)}</strong>
                <small>Toplam çalışma</small>
              </div>
            </article>
            <article className="ai-kpi-card">
              <span className="ai-kpi-icon positive" aria-hidden="true">
                <Send size={19} />
              </span>
              <div>
                <strong>{formatPercent(summary.autoRate)}</strong>
                <small>Otomatik gönderim oranı</small>
              </div>
            </article>
            <article className="ai-kpi-card">
              <span className="ai-kpi-icon" aria-hidden="true">
                <Users size={19} />
              </span>
              <div>
                <strong>{formatPercent(summary.handoffRate)}</strong>
                <small>İnsana devir oranı</small>
              </div>
            </article>
            <article className="ai-kpi-card">
              <span className="ai-kpi-icon warning" aria-hidden="true">
                <CircleDollarSign size={19} />
              </span>
              <div>
                <strong>{formatUsd(summary.cost)}</strong>
                <small>Dönem maliyeti</small>
              </div>
            </article>
          </section>

          <section className="stack-card ai-panel">
            <header className="ai-panel-header">
              <div>
                <h2>Günlük dağılım</h2>
                <p className="ai-note">
                  {metric === "cost"
                    ? "Günlük toplam maliyet (USD)."
                    : "Günlük çalışma sayısı."}
                </p>
              </div>
              <div className="ai-toolbar">
                <label>
                  <span className="sr-only">Grafik metriği</span>
                  <select
                    aria-label="Grafik metriği"
                    value={metric}
                    onChange={(event) =>
                      setMetric(event.target.value as "cost" | "runs")
                    }
                  >
                    <option value="cost">Maliyet</option>
                    <option value="runs">Çalışma sayısı</option>
                  </select>
                </label>
              </div>
            </header>
            {chart.daily.length === 0 || chart.max === 0 ? (
              <div className="empty-state">
                <Activity aria-hidden="true" />
                <h2>Bu dönemde veri yok</h2>
                <p>Ajanlar çalışmaya başladığında grafik burada oluşur.</p>
              </div>
            ) : (
              <div
                className="ai-bars"
                role="img"
                aria-label={`Günlük ${metric === "cost" ? "maliyet" : "çalışma"} grafiği`}
              >
                {chart.daily.map((day, index) => {
                  const value = chart.values[index] ?? 0;
                  const height = Math.max(
                    4,
                    Math.round((value / chart.max) * 100),
                  );
                  const title = `${day.day}: ${
                    metric === "cost"
                      ? formatUsd(value)
                      : `${formatCount(value)} çalışma`
                  }`;
                  return (
                    <span
                      key={day.day}
                      style={{ height: `${height}%` }}
                      title={title}
                    />
                  );
                })}
              </div>
            )}
          </section>

          <section className="stack-card ai-panel">
            <header className="ai-panel-header">
              <div>
                <h2>Ajan bazında kullanım</h2>
              </div>
            </header>
            {(data?.byAgent ?? []).length === 0 ? (
              <p className="ai-note ai-panel-note">
                Bu dönemde ajan kullanımı bulunmuyor.
              </p>
            ) : (
              <div className="table-card ai-table-scroll ai-borderless">
                <table>
                  <caption className="sr-only">Ajan bazında kullanım</caption>
                  <thead>
                    <tr>
                      <th>Ajan</th>
                      <th>Çalışma</th>
                      <th>Otomatik gönderim</th>
                      <th>İnsana devir</th>
                      <th>Maliyet</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(data?.byAgent ?? []).map((row) => (
                      <tr key={row.agent_id}>
                        <td>
                          <strong>{row.agent_name}</strong>
                        </td>
                        <td>{formatCount(row.runs)}</td>
                        <td>{formatCount(row.auto_sent)}</td>
                        <td>{formatCount(row.handoffs)}</td>
                        <td>{formatUsd(row.total_cost_usd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </AppFrame>
  );
}
