"use client";
import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { MessageCircleMore } from "lucide-react";
import { setAccessToken } from "../../lib/api";
const API = process.env.NEXT_PUBLIC_API_URL ?? "";
export default function RegisterPage() {
  const submitButton = useRef<HTMLButtonElement>(null);
  const router = useRouter(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => submitButton.current?.removeAttribute("disabled"), []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    const response = await fetch(`${API}/api/v1/auth/register`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        firstName: form.get("firstName"),
        lastName: form.get("lastName"),
        email: form.get("email"),
        password: form.get("password"),
      }),
    });
    const body = (await response.json()) as {
      data?: { accessToken: string };
      error?: { message: string };
    };
    if (response.ok && body.data) {
      setAccessToken(body.data.accessToken);
      router.push("/onboarding");
    } else setError(body.error?.message ?? "Hesap oluşturulamadı.");
    setBusy(false);
  }
  return (
    <main className="auth-centered">
      <section className="auth-card">
        <div className="brand-lockup dark">
          <span className="brand-mark">
            <MessageCircleMore size={20} />
          </span>
          <strong>Brixchat24</strong>
        </div>
        <p className="eyebrow">Yeni workspace</p>
        <h1>Hesabınızı oluşturun</h1>
        <form onSubmit={submit}>
          <div className="form-row">
            <label>
              Ad
              <input name="firstName" required />
            </label>
            <label>
              Soyad
              <input name="lastName" required />
            </label>
          </div>
          <label>
            E-posta
            <input name="email" type="email" required autoComplete="email" />
          </label>
          <label>
            Parola
            <input
              name="password"
              type="password"
              minLength={12}
              required
              autoComplete="new-password"
            />
            <small>En az 12 karakter; büyük, küçük harf ve rakam.</small>
          </label>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button ref={submitButton} className="primary-button" disabled>
            {busy ? "Oluşturuluyor…" : "Hesap oluştur"}
          </button>
        </form>
        <p className="auth-link">
          Zaten hesabınız var mı? <Link href="/login">Giriş yapın</Link>
        </p>
      </section>
    </main>
  );
}
