"use client";

import Link from "next/link";
import { useState } from "react";

const API = process.env.NEXT_PUBLIC_API_URL ?? "";

export default function VerifyEmailPage() {
  const [state, setState] = useState<"idle" | "busy" | "success" | "error">(
    "idle",
  );

  async function verify() {
    setState("busy");
    const token =
      new URLSearchParams(window.location.search).get("token") ?? "";
    const response = await fetch(`${API}/api/v1/auth/verify-email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    setState(response.ok ? "success" : "error");
  }

  return (
    <main className="auth-centered">
      <section className="auth-card">
        <h1>E-posta doğrulama</h1>
        <p>Hesabınızın e-posta adresini doğrulamak için devam edin.</p>
        {state === "success" ? (
          <p className="success-state">
            E-posta doğrulandı. <Link href="/app/inbox">Inbox’a gidin</Link>
          </p>
        ) : (
          <button
            className="primary-button"
            disabled={state === "busy"}
            onClick={() => void verify()}
          >
            {state === "busy" ? "Doğrulanıyor…" : "E-postayı doğrula"}
          </button>
        )}
        {state === "error" && (
          <p className="form-error" role="alert">
            Bağlantı geçersiz veya süresi dolmuş.
          </p>
        )}
      </section>
    </main>
  );
}
