"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  Eye,
  EyeOff,
  LoaderCircle,
  LockKeyhole,
  Mail,
} from "lucide-react";
import { accessToken, setAccessToken } from "../../lib/api";
import { resolveDemoLogin } from "../../lib/demo-login";
import { BrandPanel, BrandMark, SecureConnection } from "./login-visuals";
import {
  loginErrorMessage,
  networkLoginErrorMessage,
  validateLoginFields,
  type LoginFieldErrors,
} from "./login-utils";

const demoLogin =
  process.env.NODE_ENV === "development"
    ? resolveDemoLogin(
        process.env.NODE_ENV,
        process.env.NEXT_PUBLIC_DEMO_LOGIN_EMAIL,
        process.env.NEXT_PUBLIC_DEMO_LOGIN_PASSWORD,
      )
    : null;

type LoginResponse = {
  data?: { accessToken: string; onboardingRequired?: boolean; organization?: { status?: string } | null };
  error?: { code?: string };
};

export function LoginExperience() {
  const router = useRouter();
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<LoginFieldErrors>({});
  const [busy, setBusy] = useState(false);
  const [passwordVisible, setPasswordVisible] = useState(false);

  useEffect(() => {
    if (accessToken()) router.replace("/app/inbox");
  }, [router]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const data = new FormData(event.currentTarget);
    const email = String(data.get("email") ?? "").trim();
    const password = String(data.get("password") ?? "");
    const validation = validateLoginFields(email, password);
    setFieldErrors(validation);
    setError("");
    if (Object.keys(validation).length) return;

    setBusy(true);
    try {
      const response = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL ?? ""}/api/v1/auth/login`,
        {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email, password }),
        },
      );
      const body = (await response.json().catch(() => ({}))) as LoginResponse;
      if (!response.ok || !body.data) {
        setError(loginErrorMessage(response.status, body.error?.code));
        return;
      }
      setAccessToken(body.data.accessToken);
      router.replace(
        body.data.onboardingRequired
          ? "/onboarding"
          : body.data.organization?.status === "pending_review"
            ? "/pending-approval"
            : "/app/inbox",
      );
      router.refresh();
    } catch {
      setError(networkLoginErrorMessage);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="premium-login-page">
      <a className="login-skip-link" href="#main">
        Giriş formuna geç
      </a>
      <BrandPanel />
      <section
        id="main"
        className="login-form-panel"
        aria-labelledby="login-heading"
      >
        <div className="mobile-login-brand">
          <BrandMark compact />
        </div>
        <div className="login-card-shell">
          <div className="premium-login-card">
            <header>
              <p>Tekrar hoş geldiniz</p>
              <h1 id="login-heading">
                Çalışma alanınıza
                <br />
                giriş yapın
              </h1>
            </header>
            <form onSubmit={submit} noValidate>
              <div className="login-field">
                <label htmlFor="login-email">E-posta</label>
                <div className="login-input-wrap">
                  <Mail aria-hidden="true" />
                  <input
                    id="login-email"
                    name="email"
                    type="email"
                    inputMode="email"
                    autoComplete="email"
                    defaultValue={demoLogin?.email}
                    placeholder="E-posta adresinizi girin"
                    aria-invalid={Boolean(fieldErrors.email)}
                    aria-describedby={
                      fieldErrors.email ? "login-email-error" : undefined
                    }
                    onChange={() =>
                      fieldErrors.email &&
                      setFieldErrors((current) => {
                        const next = { ...current };
                        delete next.email;
                        return next;
                      })
                    }
                  />
                </div>
                {fieldErrors.email && (
                  <span id="login-email-error" className="login-field-error">
                    {fieldErrors.email}
                  </span>
                )}
              </div>
              <div className="login-field">
                <label htmlFor="login-password">Parola</label>
                <div className="login-input-wrap">
                  <LockKeyhole aria-hidden="true" />
                  <input
                    id="login-password"
                    name="password"
                    type={passwordVisible ? "text" : "password"}
                    autoComplete="current-password"
                    defaultValue={demoLogin?.password}
                    placeholder="Parolanızı girin"
                    aria-invalid={Boolean(fieldErrors.password)}
                    aria-describedby={
                      fieldErrors.password ? "login-password-error" : undefined
                    }
                    onChange={() =>
                      fieldErrors.password &&
                      setFieldErrors((current) => {
                        const next = { ...current };
                        delete next.password;
                        return next;
                      })
                    }
                  />
                  <button
                    className="password-toggle"
                    type="button"
                    aria-label={
                      passwordVisible ? "Parolayı gizle" : "Parolayı göster"
                    }
                    aria-pressed={passwordVisible}
                    onClick={() => setPasswordVisible((visible) => !visible)}
                  >
                    {passwordVisible ? (
                      <EyeOff aria-hidden="true" />
                    ) : (
                      <Eye aria-hidden="true" />
                    )}
                  </button>
                </div>
                {fieldErrors.password && (
                  <span id="login-password-error" className="login-field-error">
                    {fieldErrors.password}
                  </span>
                )}
              </div>
              {error && (
                <p
                  className="login-form-error"
                  role="alert"
                  aria-live="assertive"
                >
                  {error}
                </p>
              )}
              <button
                className="login-submit"
                type="submit"
                disabled={busy}
                aria-busy={busy}
              >
                <span>{busy ? "Giriş yapılıyor…" : "Giriş yap"}</span>
                {busy ? (
                  <LoaderCircle className="login-spinner" aria-hidden="true" />
                ) : (
                  <ArrowRight aria-hidden="true" />
                )}
              </button>
            </form>
            <div className="login-divider">
              <span>veya</span>
            </div>
            <nav className="premium-auth-links" aria-label="Hesap işlemleri">
              <Link href="/forgot-password">Parolamı unuttum</Link>
              <Link href="/register">Hesap oluştur</Link>
            </nav>
            {demoLogin && (
              <p className="login-demo-note">
                Yerel demo hesabı kullanıma hazır.
              </p>
            )}
          </div>
          <SecureConnection />
        </div>
      </section>
    </main>
  );
}
