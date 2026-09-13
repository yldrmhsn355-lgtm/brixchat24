"use client";
import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { AppFrame } from "../../../../components/app-frame";
import { apiJson } from "../../../../lib/api";
type Profile = {
  first_name: string;
  last_name: string;
  email: string;
  locale: string;
  timezone: string;
  avatar_url: string | null;
};
export default function ProfilePage() {
  const [profile, setProfile] = useState<Profile | null>(null),
    [notice, setNotice] = useState(""),
    [error, setError] = useState("");
  useEffect(() => {
    apiJson<{ data: Profile }>("/api/v1/profile")
      .then((r) => setProfile(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : "Yüklenemedi"));
  }, []);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      const result = await apiJson<{
        data: { emailVerificationRequired: boolean };
      }>("/api/v1/profile", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          firstName: f.get("firstName"),
          lastName: f.get("lastName"),
          email: f.get("email"),
          locale: f.get("locale"),
          timezone: f.get("timezone"),
        }),
      });
      setNotice(
        result.data.emailVerificationRequired
          ? "Profil güncellendi; e-posta doğrulaması gerekebilir."
          : "Profil güncellendi.",
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Güncellenemedi");
    }
  }
  return (
    <AppFrame
      title="Profil Ayarları"
      subtitle="Kişisel bilgilerinizi ve yerel tercihlerinizi yönetin."
    >
      <div className="settings-tabs">
        <Link className="active" href="/app/settings/profile">
          Profil
        </Link>
        <Link href="/app/settings/security">Güvenlik</Link>
        <Link href="/app/settings/production">Production</Link>
      </div>
      {notice && <div className="success-state">{notice}</div>}
      {error && <div className="form-error">{error}</div>}
      {profile ? (
        <form className="settings-card" onSubmit={submit}>
          <div className="form-row">
            <label>
              Ad
              <input name="firstName" defaultValue={profile.first_name} />
            </label>
            <label>
              Soyad
              <input name="lastName" defaultValue={profile.last_name} />
            </label>
          </div>
          <label>
            E-posta
            <input name="email" type="email" defaultValue={profile.email} />
            <small>Değişiklik yeniden doğrulama gerektirir.</small>
          </label>
          <div className="form-row">
            <label>
              Dil
              <select name="locale" defaultValue={profile.locale}>
                <option value="tr">Türkçe</option>
                <option value="en">English</option>
              </select>
            </label>
            <label>
              Saat dilimi
              <input name="timezone" defaultValue={profile.timezone} />
            </label>
          </div>
          <button className="primary-button">Değişiklikleri kaydet</button>
        </form>
      ) : (
        <div className="skeleton-block" />
      )}
    </AppFrame>
  );
}
