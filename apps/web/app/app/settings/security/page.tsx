"use client";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { ShieldCheck, Trash2 } from "lucide-react";
import { AppFrame } from "../../../../components/app-frame";
import { apiFetch, apiJson } from "../../../../lib/api";
type Session = {
  id: string;
  created_at: string;
  last_seen_at: string;
  ip_address: string;
  user_agent: string;
  current: boolean;
};
type Event = {
  id: string;
  event_type: string;
  created_at: string;
  ip_address: string;
};
export default function SecurityPage() {
  const [sessions, setSessions] = useState<Session[]>([]),
    [events, setEvents] = useState<Event[]>([]),
    [notice, setNotice] = useState(""),
    [error, setError] = useState(""),
    [revokingOthers, setRevokingOthers] = useState(false);
  const load = useCallback(
    () =>
      Promise.all([
        apiJson<{ data: Session[] }>("/api/v1/auth/sessions"),
        apiJson<{ data: Event[] }>("/api/v1/security-events"),
      ])
        .then(([s, e]) => {
          setSessions(s.data);
          setEvents(e.data);
        })
        .catch((e) => setError(e instanceof Error ? e.message : "Yüklenemedi")),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);
  async function password(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      await apiJson("/api/v1/auth/change-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          currentPassword: f.get("currentPassword"),
          newPassword: f.get("newPassword"),
        }),
      });
      setNotice("Parola değiştirildi ve diğer session’lar kapatıldı.");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Değiştirilemedi");
    }
  }
  async function revoke(id: string) {
    try {
      const response = await apiFetch(`/api/v1/auth/sessions/${id}`, {
        method: "DELETE",
      });
      if (!response.ok) throw new Error("Oturum kapatılamadı.");
      setNotice("Oturum kapatıldı.");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Oturum kapatılamadı.");
    }
  }
  async function revokeOthers() {
    setRevokingOthers(true);
    setError("");
    try {
      const response = await apiFetch("/api/v1/auth/sessions/revoke-others", {
        method: "POST",
      });
      if (!response.ok) throw new Error("Diğer oturumlar kapatılamadı.");
      setNotice("Diğer tüm oturumlar kapatıldı.");
      await load();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Diğer oturumlar kapatılamadı.",
      );
    } finally {
      setRevokingOthers(false);
    }
  }
  return (
    <AppFrame
      title="Güvenlik"
      subtitle="Parolanızı, aktif session’ları ve güvenlik olaylarını yönetin."
    >
      <div className="settings-tabs">
        <Link href="/app/settings/profile">Profil</Link>
        <Link className="active" href="/app/settings/security">
          Güvenlik
        </Link>
        <Link href="/app/settings/production">Production</Link>
      </div>
      {notice && <div className="success-state">{notice}</div>}
      {error && <div className="form-error">{error}</div>}
      <div className="dashboard-grid">
        <form className="settings-card" onSubmit={password}>
          <h2>Parola değiştir</h2>
          <label>
            Mevcut parola
            <input name="currentPassword" type="password" required />
          </label>
          <label>
            Yeni parola
            <input name="newPassword" type="password" minLength={12} required />
          </label>
          <button className="primary-button">Parolayı değiştir</button>
        </form>
        <section className="stack-card">
          <header>
            <h2>Aktif session’lar</h2>
            {sessions.some((session) => !session.current) && (
              <button
                className="secondary-button"
                disabled={revokingOthers}
                onClick={() => void revokeOthers()}
              >
                {revokingOthers
                  ? "Kapatılıyor…"
                  : "Diğer oturumları kapat"}
              </button>
            )}
          </header>
          {sessions.map((session) => (
            <div className="session-row" key={session.id}>
              <ShieldCheck size={18} />
              <div>
                <strong>
                  {session.current ? "Bu cihaz" : "Aktif session"}
                </strong>
                <span>
                  {session.ip_address} ·{" "}
                  {new Date(session.last_seen_at).toLocaleString("tr")}
                </span>
              </div>
              {!session.current && (
                <button
                  className="icon-button"
                  onClick={() => void revoke(session.id)}
                >
                  <Trash2 size={15} />
                </button>
              )}
            </div>
          ))}
        </section>
        <section className="table-card span-two">
          <header>
            <h2>Son güvenlik olayları</h2>
          </header>
          <table>
            <caption className="sr-only">Son güvenlik olayları</caption>
            <tbody>
              {events.map((event) => (
                <tr key={event.id}>
                  <td>{event.event_type}</td>
                  <td>{event.ip_address}</td>
                  <td>{new Date(event.created_at).toLocaleString("tr")}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="feature-placeholder">
            MFA — gelecek sürüm için hazır
          </div>
        </section>
      </div>
    </AppFrame>
  );
}
