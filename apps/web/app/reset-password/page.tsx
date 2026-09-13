"use client";
import { useState, type FormEvent } from "react";
const API = process.env.NEXT_PUBLIC_API_URL ?? "";
export default function ResetPassword() {
  const [state, setState] = useState("");
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const token =
      new URLSearchParams(window.location.search).get("token") ?? "";
    const r = await fetch(`${API}/api/v1/auth/reset-password`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, password: f.get("password") }),
    });
    setState(
      r.ok
        ? "Parolanız değiştirildi. Giriş yapabilirsiniz."
        : "Bağlantı geçersiz veya süresi dolmuş.",
    );
  }
  return (
    <main className="auth-centered">
      <section className="auth-card">
        <h1>Yeni parola</h1>
        <form onSubmit={submit}>
          <label>
            Parola
            <input name="password" type="password" minLength={12} required />
          </label>
          {state && (
            <p
              className={
                state.startsWith("Parolanız") ? "success-state" : "form-error"
              }
            >
              {state}
            </p>
          )}
          <button className="primary-button">Parolayı değiştir</button>
        </form>
      </section>
    </main>
  );
}
