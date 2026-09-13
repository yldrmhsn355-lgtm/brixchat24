"use client";
import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { apiJson, setAccessToken } from "../../lib/api";
export default function OnboardingPage() {
  const router = useRouter(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [loaded, setLoaded] = useState(false);
  const [defaultSlug] = useState(
    () => `workspace-${crypto.randomUUID().slice(0, 8)}`,
  );
  useEffect(() => {
    apiJson<{ data: { state: Record<string, string> } }>("/api/v1/onboarding")
      .then(() => setLoaded(true))
      .catch((e) => setError(e instanceof Error ? e.message : "Yüklenemedi"));
  }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    const state = {
      organizationName: form.get("organizationName"),
      slug: form.get("slug"),
      industry: form.get("industry"),
      locale: form.get("locale"),
      timezone: form.get("timezone"),
      teamName: form.get("teamName"),
    };
    try {
      await apiJson("/api/v1/onboarding", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ currentStep: 9, state }),
      });
      const complete = await apiJson<{ data: { accessToken: string } }>(
        "/api/v1/onboarding/complete",
        { method: "POST" },
      );
      setAccessToken(complete.data.accessToken);
      router.push("/pending-approval");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Tamamlanamadı");
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="auth-centered">
      <section className="auth-card wide">
        <p className="eyebrow">Onboarding</p>
        <h1>Workspace’inizi hazırlayın</h1>
        <p className="page-subtitle">
          İlerlemeniz sunucuda saklanır; daha sonra kaldığınız yerden devam
          edebilirsiniz.
        </p>
        {!loaded && !error ? (
          <div className="skeleton-block" />
        ) : (
          <form onSubmit={submit}>
            <label>
              Organizasyon adı
              <input
                name="organizationName"
                defaultValue="Brix Dental Group"
                required
              />
            </label>
            <label>
              Workspace adresi
              <input
                name="slug"
                defaultValue={defaultSlug}
                pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                required
              />
            </label>
            <div className="form-row">
              <label>
                Sektör
                <input name="industry" defaultValue="healthcare" />
              </label>
              <label>
                İlk ekip
                <input
                  name="teamName"
                  defaultValue="Customer Operations"
                  required
                />
              </label>
            </div>
            <div className="form-row">
              <label>
                Dil
                <select name="locale" defaultValue="tr">
                  <option value="tr">Türkçe</option>
                  <option value="en">English</option>
                </select>
              </label>
              <label>
                Saat dilimi
                <input
                  name="timezone"
                  defaultValue="Europe/Istanbul"
                  required
                />
              </label>
            </div>
            {error && <p className="form-error">{error}</p>}
            <button className="primary-button" disabled={busy}>
              {busy ? "Başvuru gönderiliyor…" : "Firma başvurusunu tamamla"}
            </button>
          </form>
        )}
      </section>
    </main>
  );
}
