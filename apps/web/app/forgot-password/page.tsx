"use client";
import { useState, type FormEvent } from "react";
const API = process.env.NEXT_PUBLIC_API_URL ?? "";
export default function ForgotPassword() {
  const [sent, setSent] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await fetch(`${API}/api/v1/auth/forgot-password`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: f.get("email") }),
    });
    setSent(true);
  }
  return (
    <main className="auth-centered">
      <section className="auth-card">
        <p className="eyebrow">Hesap kurtarma</p>
        <h1>Parolanızı sıfırlayın</h1>
        {sent ? (
          <div className="success-state">
            E-posta kayıtlıysa sıfırlama bağlantısı gönderildi.
          </div>
        ) : (
          <form onSubmit={submit}>
            <label>
              E-posta
              <input name="email" type="email" required />
            </label>
            <button className="primary-button">Bağlantı gönder</button>
          </form>
        )}
      </section>
    </main>
  );
}
