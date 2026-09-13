"use client";

import { Crown, ShieldCheck, Trash2, UserPlus, Users, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { apiJson } from "../lib/api";

type OrganizationUser = {
  id: string;
  full_name: string;
  email: string;
  role: string;
  is_active: boolean;
  suspended_at: string | null;
};

type ChannelAccessUser = {
  user_id: string;
  full_name: string;
  email: string;
  role: string;
  relationship_type: "owner" | "shared" | "manager";
  is_primary: boolean;
};

type RelationshipType = ChannelAccessUser["relationship_type"];

export type ChannelForAccess = {
  id: string;
  name: string;
  phoneNumber: string | null;
};

const relationshipLabels: Record<RelationshipType, string> = {
  owner: "Hat sahibi",
  manager: "Yönetici",
  shared: "Kullanıcı",
};

export function ChannelAccessDrawer({
  channel,
  onClose,
  onChanged,
}: {
  channel: ChannelForAccess;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [organizationUsers, setOrganizationUsers] = useState<
    OrganizationUser[]
  >([]);
  const [members, setMembers] = useState<ChannelAccessUser[]>([]);
  const [selectedUserId, setSelectedUserId] = useState("");
  const [selectedRelationship, setSelectedRelationship] =
    useState<RelationshipType>("shared");
  const [loading, setLoading] = useState(true);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [usersResult, membersResult] = await Promise.all([
        apiJson<{ data: OrganizationUser[] }>("/api/v1/users"),
        apiJson<{ data: ChannelAccessUser[] }>(
          `/api/v1/channels/${channel.id}/users`,
        ),
      ]);
      setOrganizationUsers(usersResult.data);
      setMembers(membersResult.data);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Kanal kullanıcıları yüklenemedi.",
      );
    } finally {
      setLoading(false);
    }
  }, [channel.id]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const availableUsers = useMemo(() => {
    const assignedIds = new Set(members.map((member) => member.user_id));
    return organizationUsers.filter(
      (user) =>
        user.is_active && !user.suspended_at && !assignedIds.has(user.id),
    );
  }, [members, organizationUsers]);

  async function saveMember(
    userId: string,
    relationshipType: RelationshipType,
    isPrimary: boolean,
    successMessage: string,
  ) {
    setBusyUserId(userId);
    setError("");
    setNotice("");
    try {
      await apiJson(`/api/v1/channels/${channel.id}/users`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId, relationshipType, isPrimary }),
      });
      await Promise.all([load(), onChanged()]);
      setNotice(successMessage);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Kullanıcı kaydedilemedi.",
      );
    } finally {
      setBusyUserId(null);
    }
  }

  async function addMember() {
    if (!selectedUserId) return;
    const makePrimary = members.length === 0;
    await saveMember(
      selectedUserId,
      makePrimary ? "owner" : selectedRelationship,
      makePrimary,
      "Kullanıcı kanala erişebilir.",
    );
    setSelectedUserId("");
    setSelectedRelationship("shared");
  }

  async function removeMember(member: ChannelAccessUser) {
    if (
      !window.confirm(
        `${member.full_name} kullanıcısının bu kanala erişimi kaldırılsın mı?`,
      )
    )
      return;
    setBusyUserId(member.user_id);
    setError("");
    setNotice("");
    try {
      await apiJson(`/api/v1/channels/${channel.id}/users/${member.user_id}`, {
        method: "DELETE",
      });
      await Promise.all([load(), onChanged()]);
      setNotice("Kanal erişimi kaldırıldı.");
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Erişim kaldırılamadı.",
      );
    } finally {
      setBusyUserId(null);
    }
  }

  return (
    <div
      className="oc-drawer-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target && !busyUserId) onClose();
      }}
    >
      <aside
        className="oc-drawer channel-access-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="channel-access-title"
      >
        <header className="oc-drawer-header">
          <div>
            <span>Kanal erişimi</span>
            <h2 id="channel-access-title">{channel.name}</h2>
            <p>{channel.phoneNumber ?? "Numara bekleniyor"}</p>
          </div>
          <button
            type="button"
            aria-label="Kanal erişimini kapat"
            disabled={Boolean(busyUserId)}
            onClick={onClose}
          >
            <X size={19} />
          </button>
        </header>

        <div className="oc-drawer-body">
          <section className="oc-drawer-summary">
            <span>
              <Users size={16} /> {members.length} kullanıcı
            </span>
            <span>
              Buradaki kullanıcılar kanalı görebilir ve kanaldan mesaj
              gönderebilir.
            </span>
          </section>

          {notice && <div className="oc-feedback success">{notice}</div>}
          {error && (
            <div className="oc-feedback error" role="alert">
              {error}
            </div>
          )}

          <section className="oc-form-section channel-access-add">
            <header>
              <span>
                <UserPlus size={17} />
              </span>
              <div>
                <h3>Kullanıcı ekle</h3>
                <p>Aktif ekip üyelerinden birini bu hatta yetkilendirin.</p>
              </div>
            </header>
            <div className="channel-access-add-grid">
              <label>
                Kullanıcı
                <select
                  value={selectedUserId}
                  disabled={loading || Boolean(busyUserId)}
                  onChange={(event) => setSelectedUserId(event.target.value)}
                >
                  <option value="">Kullanıcı seçin</option>
                  {availableUsers.map((user) => (
                    <option key={user.id} value={user.id}>
                      {user.full_name} · {user.email}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Yetki
                <select
                  value={selectedRelationship}
                  disabled={loading || Boolean(busyUserId)}
                  onChange={(event) =>
                    setSelectedRelationship(
                      event.target.value as RelationshipType,
                    )
                  }
                >
                  {Object.entries(relationshipLabels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="primary-button"
                disabled={!selectedUserId || Boolean(busyUserId)}
                onClick={() => void addMember()}
              >
                <UserPlus size={15} /> Ekle
              </button>
            </div>
          </section>

          <section className="oc-form-section">
            <header>
              <span>
                <ShieldCheck size={17} />
              </span>
              <div>
                <h3>Kullanabilecek kişiler</h3>
                <p>Birincil sahip ve kanal erişim rollerini yönetin.</p>
              </div>
            </header>
            {loading ? (
              <div className="skeleton-grid" />
            ) : members.length === 0 ? (
              <div className="empty-state compact-empty">
                Kanala atanmış kullanıcı yok.
              </div>
            ) : (
              <div className="channel-access-list">
                {members.map((member) => (
                  <article key={member.user_id}>
                    <div className="channel-access-person">
                      <strong>
                        {member.is_primary && <Crown size={15} />}
                        {member.full_name}
                      </strong>
                      <small>
                        {member.email} · {member.role}
                      </small>
                    </div>
                    <select
                      aria-label={`${member.full_name} kanal yetkisi`}
                      value={member.relationship_type}
                      disabled={busyUserId === member.user_id}
                      onChange={(event) =>
                        void saveMember(
                          member.user_id,
                          event.target.value as RelationshipType,
                          member.is_primary,
                          "Kanal yetkisi güncellendi.",
                        )
                      }
                    >
                      {Object.entries(relationshipLabels).map(
                        ([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ),
                      )}
                    </select>
                    <button
                      type="button"
                      className={member.is_primary ? "is-primary" : ""}
                      aria-label={`${member.full_name} birincil sahip yap`}
                      title={
                        member.is_primary
                          ? "Birincil sahip"
                          : "Birincil sahip yap"
                      }
                      disabled={member.is_primary || Boolean(busyUserId)}
                      onClick={() =>
                        void saveMember(
                          member.user_id,
                          "owner",
                          true,
                          "Birincil hat sahibi güncellendi.",
                        )
                      }
                    >
                      <Crown size={16} />
                    </button>
                    <button
                      type="button"
                      className="destructive-icon-button"
                      aria-label={`${member.full_name} erişimini kaldır`}
                      title="Erişimi kaldır"
                      disabled={members.length === 1 || Boolean(busyUserId)}
                      onClick={() => void removeMember(member)}
                    >
                      <Trash2 size={16} />
                    </button>
                  </article>
                ))}
              </div>
            )}
          </section>
        </div>
      </aside>
    </div>
  );
}
