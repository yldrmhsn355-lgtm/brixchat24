"use client";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { AppFrame } from "../../../../components/app-frame";
import { apiJson } from "../../../../lib/api";

type Check = {
  check: string;
  status: "pass" | "warning" | "fatal";
  description: string;
};
type Privacy = {
  id: string;
  request_type: string;
  status: string;
  legal_hold_conflict: boolean;
  requested_at: string;
};
type Configuration = { environment: string; valid: boolean; checks: Check[] };
type Usage = {
  metrics: Record<string, number>;
  plan: string | null;
  trial: { status: string; endsAt?: string } | null;
};
export default function ProductionSettingsPage() {
  const [configuration, setConfiguration] = useState<Configuration | null>(
      null,
    ),
    [version, setVersion] = useState<Record<string, string>>({}),
    [usage, setUsage] = useState<Usage | null>(null),
    [privacy, setPrivacy] = useState<Privacy[]>([]),
    [notice, setNotice] = useState(""),
    [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      const [c, v, u, p] = await Promise.all([
        apiJson<{ data: Configuration }>("/health/configuration"),
        apiJson<{ data: Record<string, string> }>("/version"),
        apiJson<{ data: Usage }>("/api/v1/usage/current"),
        apiJson<{ data: Privacy[] }>("/api/v1/privacy/requests"),
      ]);
      setConfiguration(c.data);
      setVersion(v.data);
      setUsage(u.data);
      setPrivacy(p.data);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Production bilgileri yüklenemedi",
      );
    }
  }, []);
  // Defer the initial request to a microtask. This keeps the effect focused on
  // starting the async side effect while avoiding a synchronous state update
  // during effect execution (React's set-state-in-effect rule).
  useEffect(() => {
    void Promise.resolve().then(() => load());
  }, [load]);
  async function createPrivacy(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget,
      data = new FormData(form);
    try {
      await apiJson("/api/v1/privacy/requests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          subjectReference: data.get("subjectReference"),
          type: data.get("type"),
        }),
      });
      setNotice("Privacy request kaydedildi ve audit geçmişi oluşturuldu.");
      form.reset();
      await load();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Request oluşturulamadı",
      );
      await load();
    }
  }
  return (
    <AppFrame
      title="Production ve uyumluluk"
      subtitle="Güvenli configuration, kullanım, trial ve privacy operasyonları."
    >
      <div className="settings-tabs">
        <Link href="/app/settings/profile">Profil</Link>
        <Link href="/app/settings/security">Güvenlik</Link>
        <Link className="active" href="/app/settings/production">
          Production
        </Link>
      </div>
      {notice && <div className="success-state">{notice}</div>}
      {error && <div className="form-error">{error}</div>}
      <div className="dashboard-grid">
        <section className="stack-card">
          <h2>Configuration</h2>
          <p>
            {configuration?.environment ?? "…"} ·{" "}
            {configuration?.valid ? "ready" : "external acceptance pending"}
          </p>
          {configuration?.checks.map((check) => (
            <div className="session-row" key={check.check}>
              <strong>{check.check}</strong>
              <span>
                {check.status} · {check.description}
              </span>
            </div>
          ))}
        </section>
        <section className="stack-card">
          <h2>Version</h2>
          <p>
            {version.version} · {version.environment}
          </p>
          <small>
            {version.commitSha} · migration {version.migrationVersion}
          </small>
          <h2>Plan ve kullanım</h2>
          <p>
            {usage?.plan ?? "—"} · trial {usage?.trial?.status ?? "inactive"}
          </p>
          {Object.entries(usage?.metrics ?? {}).map(([metric, value]) => (
            <div className="session-row" key={metric}>
              <span>{metric}</span>
              <strong>{value}</strong>
            </div>
          ))}
        </section>
        <form className="settings-card" onSubmit={createPrivacy}>
          <h2>Privacy request</h2>
          <label>
            Subject reference
            <input name="subjectReference" required minLength={3} />
          </label>
          <label>
            İşlem
            <select name="type">
              <option value="export">Export</option>
              <option value="restrict">Restriction</option>
              <option value="delete">Deletion</option>
            </select>
          </label>
          <button className="primary-button">Request oluştur</button>
        </form>
        <section className="table-card">
          <h2>Privacy geçmişi</h2>
          {privacy.map((item) => (
            <div className="session-row" key={item.id}>
              <strong>{item.request_type}</strong>
              <span>
                {item.status}
                {item.legal_hold_conflict ? " · legal hold" : ""}
              </span>
            </div>
          ))}
        </section>
      </div>
    </AppFrame>
  );
}
