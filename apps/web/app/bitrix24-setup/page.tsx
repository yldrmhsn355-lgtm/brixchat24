"use client";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { setAccessToken } from "../../lib/api";

const API = process.env.NEXT_PUBLIC_API_URL ?? "";

type CompleteResponse = {
  data?: { accessToken: string };
  error?: { code?: string; message?: string };
};

export default function BitrixSetupPage() {
  const router = useRouter();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const token = new URLSearchParams(window.location.search).get("token") ?? "";
    const f = new FormData(e.currentTarget);
    setError("");
    setBusy(true);
    try {
      const response = await fetch(
        `${API}/api/v1/auth/bitrix24-setup/complete`,
        {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            token,
            email: f.get("email"),
            password: f.get("password"),
            firstName: f.get("firstName"),
            lastName: f.get("lastName"),
          }),
        },
      );
      const body = (await response.json().catch(() => ({}))) as CompleteResponse;
      if (!response.ok || !body.data) {
        setError(
          body.error?.code === "email_taken"
            ? "Bu e-posta adresi zaten kullanılıyor."
            : "Bağlantı geçersiz veya süresi dolmuş. Bitrix24 uygulamasını tekrar yükleyip deneyin.",
        );
        return;
      }
      setAccessToken(body.data.accessToken);
      router.replace("/app/inbox");
      router.refresh();
    } catch {
      setError("Bağlantı kurulamadı. Lütfen tekrar deneyin.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-centered">
      <section className="auth-card">
        <h1>Brixchat24 kurulumunu tamamla</h1>
        <p className="muted">
          Bitrix24 uygulamanız kuruldu. Hesabınıza giriş yapabilmek için
          e-posta adresinizi ve bir parola belirleyin.
        </p>
        <form onSubmit={submit}>
          <label>
            Ad
            <input name="firstName" type="text" maxLength={80} required />
          </label>
          <label>
            Soyad
            <input name="lastName" type="text" maxLength={80} required />
          </label>
          <label>
            E-posta
            <input name="email" type="email" maxLength={320} required />
          </label>
          <label>
            Parola
            <input name="password" type="password" minLength={12} required />
          </label>
          {error && <p className="form-error">{error}</p>}
          <button className="primary-button" disabled={busy}>
            {busy ? "Kaydediliyor…" : "Kurulumu tamamla"}
          </button>
        </form>
      </section>
    </main>
  );
}
