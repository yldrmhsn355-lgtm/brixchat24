"use client";

import { useCallback, useEffect, useState } from "react";
import { KeyRound, RefreshCw, ShieldAlert, Trash2 } from "lucide-react";
import { AppFrame } from "./app-frame";
import { AiNav } from "./ai-nav";
import { AiModelInput } from "./ai-model-picker";
import { apiJson } from "../lib/api";
import { toNumber } from "./ai-management";

type AiSettings = {
  globalEnabled: boolean;
  enabled: boolean;
  hasApiKey: boolean;
  hasEnvApiKey: boolean;
  defaultModel: string | null;
  fallbackModel: string | null;
  dailyBudgetUsd: number | string | null;
  debounceMs: number | string | null;
  config: {
    sensitiveBusinessMode?: boolean;
    extraPolicy?: string;
    takeoverPauseMinutes?: number;
  } | null;
  environmentDefaultModel: string | null;
};

type SettingsForm = {
  enabled: boolean;
  apiKey: string;
  defaultModel: string;
  fallbackModel: string;
  dailyBudgetUsd: string;
  debounceMs: string;
  sensitiveBusinessMode: boolean;
  extraPolicy: string;
  takeoverPauseMinutes: string;
};

export function AiSettingsWorkspace() {
  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [form, setForm] = useState<SettingsForm | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await apiJson<{ data: AiSettings }>("/api/v1/ai/settings");
      setSettings(result.data);
      setForm({
        enabled: result.data.enabled,
        apiKey: "",
        defaultModel: result.data.defaultModel ?? "",
        fallbackModel: result.data.fallbackModel ?? "",
        dailyBudgetUsd:
          result.data.dailyBudgetUsd != null
            ? String(result.data.dailyBudgetUsd)
            : "",
        debounceMs:
          result.data.debounceMs != null ? String(result.data.debounceMs) : "",
        sensitiveBusinessMode:
          result.data.config?.sensitiveBusinessMode ?? false,
        extraPolicy: result.data.config?.extraPolicy ?? "",
        takeoverPauseMinutes:
          result.data.config?.takeoverPauseMinutes != null
            ? String(result.data.config.takeoverPauseMinutes)
            : "30",
      });
      setError("");
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "AI ayarları yüklenemedi.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  function update(partial: Partial<SettingsForm>) {
    setForm((current) => (current ? { ...current, ...partial } : current));
  }

  async function save() {
    if (!form || saving) return;
    setSaving(true);
    setError("");
    try {
      await apiJson("/api/v1/ai/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enabled: form.enabled,
          ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
          defaultModel: form.defaultModel || null,
          fallbackModel: form.fallbackModel || null,
          dailyBudgetUsd: toNumber(form.dailyBudgetUsd),
          debounceMs: Math.max(0, Math.round(toNumber(form.debounceMs))),
          sensitiveBusinessMode: form.sensitiveBusinessMode,
          extraPolicy: form.extraPolicy,
          takeoverPauseMinutes: Math.max(
            0,
            Math.round(toNumber(form.takeoverPauseMinutes)),
          ),
        }),
      });
      setNotice("AI ayarları kaydedildi.");
      await load();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Ayarlar kaydedilemedi.",
      );
    } finally {
      setSaving(false);
    }
  }

  async function removeApiKey() {
    if (saving) return;
    if (
      !window.confirm(
        "Kayıtlı API anahtarı silinsin mi? Ortam anahtarı yoksa AI yanıtları durur.",
      )
    )
      return;
    setSaving(true);
    setError("");
    try {
      await apiJson("/api/v1/ai/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey: null }),
      });
      setNotice("API anahtarı kaldırıldı.");
      await load();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "API anahtarı kaldırılamadı.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <AppFrame
      title="AI Ayarları"
      subtitle="Çalışma alanı genelinde AI özelliklerini, modeli ve bütçeyi yönetin."
    >
      <AiNav />

      {notice && (
        <div className="success-banner ai-feedback" role="status">
          {notice}
          <button type="button" onClick={() => setNotice("")}>
            Kapat
          </button>
        </div>
      )}
      {error && (
        <div className="error-banner ai-feedback" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => void load()}>
            <RefreshCw size={14} aria-hidden="true" /> Yeniden dene
          </button>
        </div>
      )}

      {loading || !form || !settings ? (
        <div className="ai-skeleton-list" aria-label="Yükleniyor">
          <span className="skeleton-block" />
          <span className="skeleton-block" />
        </div>
      ) : (
        <>
          {!settings.globalEnabled && (
            <div className="error-banner ai-feedback" role="alert">
              <span>
                <ShieldAlert size={15} aria-hidden="true" /> Sunucuda
                AI_ENABLED kapalı. Buradaki ayarlar kaydedilir ancak sunucu
                yöneticisi özelliği açana kadar AI yanıtları üretilmez.
              </span>
            </div>
          )}

          <section className="stack-card ai-detail-card">
            <h2>Genel</h2>
            <label className="ai-checkbox-row">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(event) => update({ enabled: event.target.checked })}
              />
              <span>
                <strong>AI özellikleri etkin</strong>
                <small className="ai-note">
                  {" "}
                  Kapatıldığında hiçbir ajan yanıt üretmez.
                </small>
              </span>
            </label>

            <h3 className="ai-subheading">
              <KeyRound size={15} aria-hidden="true" /> OpenRouter API anahtarı
            </h3>
            <p className="ai-note">
              {settings.hasApiKey
                ? "Kayıtlı ✓ — Çalışma alanına özel anahtar kullanılıyor."
                : settings.hasEnvApiKey
                  ? "Ortam anahtarı kullanılıyor — sunucu genel anahtarı devrede."
                  : "Anahtar tanımlı değil. AI yanıtları için bir anahtar girin."}
            </p>
            <div className="ai-key-row">
              <label>
                Yeni anahtar
                <input
                  type="password"
                  autoComplete="off"
                  value={form.apiKey}
                  placeholder={
                    settings.hasApiKey
                      ? "Değiştirmek için yeni anahtar girin"
                      : "sk-or-…"
                  }
                  onChange={(event) => update({ apiKey: event.target.value })}
                />
              </label>
              {settings.hasApiKey && (
                <button
                  type="button"
                  className="subtle-button danger"
                  onClick={() => void removeApiKey()}
                  disabled={saving}
                >
                  <Trash2 size={14} aria-hidden="true" /> Anahtarı kaldır
                </button>
              )}
            </div>

            <div className="ai-form-grid">
              <label>
                Varsayılan model
                <AiModelInput
                  value={form.defaultModel}
                  placeholder={
                    settings.environmentDefaultModel ?? "openai/gpt-4o-mini"
                  }
                  onChange={(value) => update({ defaultModel: value })}
                />
                {settings.environmentDefaultModel && (
                  <small className="ai-note">
                    Boş bırakılırsa sunucu varsayılanı:{" "}
                    {settings.environmentDefaultModel}
                  </small>
                )}
              </label>
              <label>
                Yedek model
                <AiModelInput
                  value={form.fallbackModel}
                  placeholder="google/gemini-flash-1.5"
                  onChange={(value) => update({ fallbackModel: value })}
                />
              </label>
              <label>
                Günlük bütçe (USD)
                <input
                  type="number"
                  min={0}
                  step={0.5}
                  value={form.dailyBudgetUsd}
                  onChange={(event) =>
                    update({ dailyBudgetUsd: event.target.value })
                  }
                />
                <small className="ai-note">
                  Bütçe aşıldığında ajanlar gün sonuna kadar durur.
                </small>
              </label>
              <label>
                Yanıt bekleme süresi (ms)
                <input
                  type="number"
                  min={0}
                  step={500}
                  value={form.debounceMs}
                  onChange={(event) =>
                    update({ debounceMs: event.target.value })
                  }
                />
                <small className="ai-note">
                  Müşteri art arda yazarken ajan bu süre kadar bekler.
                </small>
              </label>
              <label>
                Devralma sonrası duraklama (dakika)
                <input
                  type="number"
                  min={0}
                  value={form.takeoverPauseMinutes}
                  onChange={(event) =>
                    update({ takeoverPauseMinutes: event.target.value })
                  }
                />
                <small className="ai-note">
                  Bir temsilci konuşmayı devraldığında ajan bu süre boyunca
                  sessiz kalır.
                </small>
              </label>
            </div>

            <h3 className="ai-subheading">Politikalar</h3>
            <label className="ai-checkbox-row">
              <input
                type="checkbox"
                checked={form.sensitiveBusinessMode}
                onChange={(event) =>
                  update({ sensitiveBusinessMode: event.target.checked })
                }
              />
              <span>
                <strong>Hassas sektör modu</strong>
                <small className="ai-note">
                  {" "}
                  Sağlık, hukuk ve finans gibi hassas sektörler için daha
                  temkinli yanıtlar ve daha sık insana devir.
                </small>
              </span>
            </label>
            <label>
              Ek politika metni
              <textarea
                className="ai-textarea-tall"
                value={form.extraPolicy}
                placeholder="Tüm ajanlara uygulanacak ek kurallar (örn. KVKK uyarıları, yasal ifadeler)."
                onChange={(event) => update({ extraPolicy: event.target.value })}
              />
            </label>

            <div className="ai-tab-actions">
              <button
                type="button"
                className="primary-button"
                onClick={() => void save()}
                disabled={saving}
              >
                {saving ? "Kaydediliyor…" : "Ayarları kaydet"}
              </button>
            </div>
          </section>
        </>
      )}
    </AppFrame>
  );
}
