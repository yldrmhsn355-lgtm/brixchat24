"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";

const API = process.env.NEXT_PUBLIC_API_URL ?? "";

export default function InvitationPage() {
  const [state, setState] = useState<"idle" | "busy" | "success" | "error">(
    "idle",
  );

  async function accept(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState("busy");
    const form = new FormData(event.currentTarget);
    const token =
      new URLSearchParams(window.location.search).get("token") ?? "";
    const response = await fetch(`${API}/api/v1/invitations/accept`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token,
        firstName: form.get("firstName"),
        lastName: form.get("lastName"),
        password: form.get("password"),
      }),
    });
    setState(response.ok ? "success" : "error");
  }

  return (
    <main className="auth-centered">
      <section className="auth-card">
        <h1>Workspace daveti</h1>
        {state === "success" ? (
          <p className="success-state">
            Davet kabul edildi. <Link href="/login">Giriş yapın</Link>
          </p>
        ) : (
          <form onSubmit={accept}>
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
              Parola
              <input name="password" type="password" minLength={12} required />
            </label>
            <button className="primary-button" disabled={state === "busy"}>
              {state === "busy" ? "Kabul ediliyor…" : "Daveti kabul et"}
            </button>
          </form>
        )}
        {state === "error" && (
          <p className="form-error" role="alert">
            Davet geçersiz, kullanılmış veya süresi dolmuş.
          </p>
        )}
      </section>
    </main>
  );
}
