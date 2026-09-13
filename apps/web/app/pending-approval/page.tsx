"use client";

import { useEffect, useState } from "react";
import { apiJson, logout } from "../../lib/api";
import "../platform-admin/platform-admin.css";

export default function PendingApprovalPage() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState("pending_review");

  useEffect(() => {
    void apiJson<{ data: { email: string; organizationStatus?: string } }>(
      "/api/v1/auth/me",
    )
      .then(({ data }) => {
        setEmail(data.email);
        setStatus(data.organizationStatus ?? "active");
        if (data.organizationStatus === "active")
          window.location.replace("/app/inbox");
      })
      .catch(() => window.location.replace("/login"));
  }, []);

  return (
    <main className="pending-approval-page">
      <section
        className="pending-approval-card"
        aria-labelledby="pending-title"
      >
        <div className="pending-approval-mark" aria-hidden="true">
          B24
        </div>
        <p className="eyebrow">Brixchat24 çalışma alanı</p>
        <h1 id="pending-title">
          {status === "rejected" ? "Başvurunuz incelendi" : "Onay bekleniyor"}
        </h1>
        <p>
          Firma kaydınız platform yöneticisine ulaştı. Onay verildiğinde 14
          günlük denemeniz başlayacak ve tüm modüller açılacak.
        </p>
        {email && (
          <div className="pending-approval-account">Oturum: {email}</div>
        )}
        <div className="pending-approval-actions">
          <button type="button" onClick={() => window.location.reload()}>
            Durumu yenile
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => void logout()}
          >
            Çıkış yap
          </button>
        </div>
      </section>
    </main>
  );
}
