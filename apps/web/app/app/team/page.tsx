"use client";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  Layers3,
  Plus,
  UserCheck,
  UserRoundPlus,
  UsersRound,
} from "lucide-react";
import { AppFrame } from "../../../components/app-frame";
import { apiJson } from "../../../lib/api";
type User = {
  id: string;
  full_name: string;
  email: string;
  role: string;
  is_active: boolean;
  suspended_at: string | null;
};
type Team = { id: string; name: string; member_count: number };
export default function TeamPage() {
  const [users, setUsers] = useState<User[]>([]),
    [teams, setTeams] = useState<Team[]>([]),
    [show, setShow] = useState<"invite" | "team" | null>(null),
    [notice, setNotice] = useState(""),
    [error, setError] = useState("");
  const activeUsers = users.filter(
    (user) => user.is_active && !user.suspended_at,
  ).length;
  const load = useCallback(
    () =>
      Promise.all([
        apiJson<{ data: User[] }>("/api/v1/users"),
        apiJson<{ data: Team[] }>("/api/v1/teams"),
      ])
        .then(([u, t]) => {
          setUsers(u.data);
          setTeams(t.data);
        })
        .catch((e) => setError(e instanceof Error ? e.message : "Yüklenemedi")),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      if (show === "invite")
        await apiJson("/api/v1/invitations", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: f.get("email"), role: f.get("role") }),
        });
      else
        await apiJson("/api/v1/teams", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: f.get("name") }),
        });
      setNotice(show === "invite" ? "Davet gönderildi." : "Ekip oluşturuldu.");
      setShow(null);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "İşlem başarısız");
    }
  }
  async function role(id: string, role: string) {
    try {
      await apiJson(`/api/v1/users/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role }),
      });
      await load();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Rol değiştirilemedi",
      );
    }
  }
  return (
    <AppFrame
      title="Ekip"
      subtitle="Üyeleri, rolleri, davetleri ve ekipleri yönetin."
      actions={
        <>
          <button className="secondary-button" onClick={() => setShow("team")}>
            <Plus size={15} />
            Ekip
          </button>
          <button
            className="primary-button compact-button"
            onClick={() => setShow("invite")}
          >
            <UserRoundPlus size={15} />
            Davet et
          </button>
        </>
      }
    >
      {notice && <div className="success-state">{notice}</div>}
      {error && <div className="form-error">{error}</div>}
      {show && (
        <div className="modal-backdrop" role="presentation">
          <form
            aria-labelledby="team-dialog-title"
            aria-modal="true"
            className="modal-card"
            role="dialog"
            onSubmit={submit}
          >
            <h2 id="team-dialog-title">
              {show === "invite" ? "Kullanıcı davet et" : "Ekip oluştur"}
            </h2>
            {show === "invite" ? (
              <>
                <label>
                  E-posta
                  <input name="email" type="email" required />
                </label>
                <label>
                  Rol
                  <select name="role">
                    <option value="agent">Agent</option>
                    <option value="team_lead">Team lead</option>
                    <option value="admin">Admin</option>
                    <option value="viewer">Viewer</option>
                  </select>
                </label>
              </>
            ) : (
              <label>
                Ekip adı
                <input name="name" required />
              </label>
            )}
            <div className="modal-actions">
              <button type="button" onClick={() => setShow(null)}>
                Vazgeç
              </button>
              <button className="primary-button">Kaydet</button>
            </div>
          </form>
        </div>
      )}
      <section className="team-summary-grid" aria-label="Ekip özeti">
        <article>
          <span className="team-summary-icon neutral">
            <UsersRound size={19} aria-hidden="true" />
          </span>
          <div>
            <small>Toplam kullanıcı</small>
            <strong>{users.length}</strong>
          </div>
        </article>
        <article>
          <span className="team-summary-icon active">
            <UserCheck size={19} aria-hidden="true" />
          </span>
          <div>
            <small>Aktif kullanıcı</small>
            <strong>{activeUsers}</strong>
          </div>
        </article>
        <article>
          <span className="team-summary-icon teams">
            <Layers3 size={19} aria-hidden="true" />
          </span>
          <div>
            <small>Tanımlı ekip</small>
            <strong>{teams.length}</strong>
          </div>
        </article>
      </section>
      <div className="dashboard-grid">
        <section className="table-card span-two">
          <header>
            <h2>Kullanıcılar</h2>
          </header>
          <table>
            <caption className="sr-only">Ekip kullanıcıları</caption>
            <thead>
              <tr>
                <th>Kullanıcı</th>
                <th>Rol</th>
                <th>Durum</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id}>
                  <td>
                    <strong>{user.full_name}</strong>
                    <small>{user.email}</small>
                  </td>
                  <td>
                    <select
                      value={user.role}
                      onChange={(e) => void role(user.id, e.target.value)}
                    >
                      <option value="owner">Owner</option>
                      <option value="admin">Admin</option>
                      <option value="team_lead">Team lead</option>
                      <option value="agent">Agent</option>
                      <option value="viewer">Viewer</option>
                    </select>
                  </td>
                  <td>
                    <span
                      className={`status-pill ${user.suspended_at ? "unhealthy" : "healthy"}`}
                    >
                      {user.suspended_at ? "Askıda" : "Aktif"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <section className="stack-card">
          <h2>Ekipler</h2>
          {teams.length > 0 ? (
            teams.map((team) => (
              <div className="team-row" key={team.id}>
                <span className="team-avatar" aria-hidden="true">
                  {team.name.slice(0, 2).toLocaleUpperCase("tr")}
                </span>
                <strong>{team.name}</strong>
                <span>{team.member_count} üye</span>
              </div>
            ))
          ) : (
            <div className="team-empty-state">
              <Layers3 size={22} aria-hidden="true" />
              <strong>Henüz ekip oluşturulmadı</strong>
              <p>Kullanıcıları operasyon gruplarında toplamak için ekip oluşturun.</p>
              <button
                className="secondary-button"
                onClick={() => setShow("team")}
              >
                <Plus size={15} aria-hidden="true" />
                İlk ekibi oluştur
              </button>
            </div>
          )}
        </section>
      </div>
    </AppFrame>
  );
}
