"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AppFrame } from "../../../components/app-frame";
import { apiJson } from "../../../lib/api";

type Price = {
  id: string;
  provider: string;
  providerPriceRef: string | null;
  currency: string;
  interval: "month" | "year" | "one_time";
  unitAmountMinor: number | string;
  creditsPerUnit: number | string | null;
  taxMode: string;
};
type Product = {
  id: string;
  code: string;
  name: string;
  product_type: "plan" | "channel" | "seat" | "credit";
  plan_code: string | null;
  features: Record<string, unknown>;
  prices: Price[];
};
type Subscription = {
  id: string;
  provider: string;
  plan_code: string | null;
  status: string;
  current_period_start: string | null;
  current_period_end: string | null;
  grace_ends_at: string | null;
  cancel_at_period_end: boolean;
  items: Array<{
    id: string;
    productCode: string;
    productName: string;
    productType: string;
    quantity: number;
  }>;
};
type Overview = {
  subscriptions: Subscription[];
  entitlement: {
    code: string;
    display_name: string;
    limits: Record<string, number | boolean | null>;
    overrides: Record<string, number | boolean | null>;
    trial_status: string;
    trial_ends_at: string | null;
  } | null;
  usage: Array<{ metric: string; quantity: number | string }>;
  credits: {
    balance: number | string;
    total_purchased: number | string;
    total_used: number | string;
    auto_recharge_enabled: boolean;
    auto_recharge_threshold: number | string;
    auto_recharge_amount: number | string;
  };
  transactions: Array<{
    id: string;
    provider: string;
    status: string;
    currency: string;
    subtotal_minor: number | string;
    tax_minor: number | string;
    total_minor: number | string;
    invoice_number: string | null;
    billed_at: string | null;
    created_at: string;
  }>;
  creditLedger: Array<{
    id: string;
    entry_type: string;
    amount: number | string;
    balance_after: number | string;
    created_at: string;
  }>;
  lineCapacity: Array<{
    family: "whatsapp" | "telegram";
    product_code: "whatsapp_line" | "telegram_line";
    included: number | string | null;
    addon: number | string;
    manual_addon: number | string;
    used: number | string;
  }>;
  salesRequests: Array<{
    id: string;
    product_code: string;
    product_name: string;
    quantity: number;
    status: "pending" | "approved" | "rejected" | "canceled";
    created_at: string;
  }>;
};
type ProviderConfig = {
  provider: "paddle";
  configured: boolean;
  clientToken?: string;
  environment?: "sandbox" | "production";
};

declare global {
  interface Window {
    Paddle?: {
      Environment: { set(value: "sandbox"): void };
      Initialize(options: {
        token: string;
        eventCallback?: (event: { name?: string }) => void;
      }): void;
      Checkout: { open(options: { transactionId: string }): void };
    };
    __brixchatPaddleInitialized?: boolean;
  }
}

const statusLabels: Record<string, string> = {
  active: "Aktif",
  trialing: "Deneme",
  past_due: "Ödeme gecikmiş",
  paused: "Duraklatıldı",
  canceled: "İptal",
  incomplete: "Tamamlanmadı",
  legacy_free: "Mevcut müşteri · ücretsiz",
  manual: "Manuel",
  paid: "Ödendi",
  ready: "Ödemeye hazır",
  failed: "Başarısız",
};
const intervalLabels = { month: "ay", year: "yıl", one_time: "tek sefer" };
const metricLabels: Record<string, string> = {
  outgoing_messages: "Giden mesaj",
  monthly_outgoing_messages: "Giden mesaj",
  channels: "Kanal",
  users: "Kullanıcı",
  automations: "Otomasyon",
  storage_bytes: "Depolama",
  ai_runs: "AI çalışması",
};
const number = (value: number | string | null | undefined) =>
  Number(value ?? 0);
const money = (value: number | string, currency: string) =>
  new Intl.NumberFormat("tr-TR", {
    style: "currency",
    currency,
  }).format(number(value) / 100);
const date = (value: string | null) =>
  value ? new Date(value).toLocaleDateString("tr-TR") : "—";

async function loadPaddle(config: ProviderConfig, onCompleted: () => void) {
  if (!config.configured || !config.clientToken)
    throw new Error("Ödeme sağlayıcısı yapılandırılmadı.");
  if (!window.Paddle) {
    await new Promise<void>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://cdn.paddle.com/paddle/v2/paddle.js";
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("Paddle yüklenemedi."));
      document.head.appendChild(script);
    });
  }
  if (!window.Paddle) throw new Error("Paddle yüklenemedi.");
  if (!window.__brixchatPaddleInitialized) {
    if (config.environment === "sandbox")
      window.Paddle.Environment.set("sandbox");
    window.Paddle.Initialize({
      token: config.clientToken,
      eventCallback: (event) => {
        if (event.name === "checkout.completed") onCompleted();
      },
    });
    window.__brixchatPaddleInitialized = true;
  }
  return window.Paddle;
}

export default function BillingPage() {
  const [catalog, setCatalog] = useState<Product[]>([]);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [provider, setProvider] = useState<ProviderConfig>({
    provider: "paddle",
    configured: false,
  });
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [lineQuantities, setLineQuantities] = useState<Record<string, number>>({
    whatsapp_line: 1,
    telegram_line: 1,
  });

  const load = useCallback(() => {
    return Promise.all([
      apiJson<{ data: Product[] }>("/api/v1/billing/catalog"),
      apiJson<{ data: Overview }>("/api/v1/billing/overview"),
      apiJson<{ data: ProviderConfig }>("/api/v1/billing/provider-config"),
    ]).then(([catalogResult, overviewResult, providerResult]) => {
      setCatalog(catalogResult.data);
      setOverview(overviewResult.data);
      setProvider(providerResult.data);
    });
  }, []);

  useEffect(() => {
    void load().catch((reason) =>
      setError(
        reason instanceof Error ? reason.message : "Abonelik yüklenemedi.",
      ),
    );
  }, [load]);

  const subscription = useMemo(
    () =>
      overview?.subscriptions.find((item) => item.provider === "paddle") ??
      overview?.subscriptions[0] ??
      null,
    [overview],
  );
  const limits = {
    ...(overview?.entitlement?.limits ?? {}),
    ...(overview?.entitlement?.overrides ?? {}),
  };

  async function buy(price: Price, quantity = 1) {
    setBusy(price.id);
    setError("");
    try {
      const result = await apiJson<{
        data: {
          transactionId: string;
          checkoutUrl: string | null;
          clientToken: string;
          environment: "sandbox" | "production";
        };
      }>("/api/v1/billing/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          priceId: price.id,
          quantity,
        }),
      });
      const paddle = await loadPaddle(
        {
          provider: "paddle",
          configured: true,
          clientToken: result.data.clientToken,
          environment: result.data.environment,
        },
        () => {
          setNotice(
            "Ödeme alındı. Abonelik webhook doğrulamasından sonra güncellenecek.",
          );
          window.setTimeout(() => void load(), 1500);
        },
      );
      paddle.Checkout.open({ transactionId: result.data.transactionId });
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Ödeme başlatılamadı.",
      );
    } finally {
      setBusy("");
    }
  }

  async function openPortal() {
    setBusy("portal");
    setError("");
    try {
      const result = await apiJson<{ data: { url: string } }>(
        "/api/v1/billing/portal-session",
        { method: "POST" },
      );
      window.open(result.data.url, "_blank", "noopener,noreferrer");
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Yönetim ekranı açılamadı.",
      );
    } finally {
      setBusy("");
    }
  }

  async function requestLine(product: Product) {
    const quantity = Math.max(
      1,
      Math.min(500, lineQuantities[product.code] ?? 1),
    );
    setBusy(`request-${product.id}`);
    setError("");
    setNotice("");
    try {
      await apiJson("/api/v1/billing/line-requests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ productCode: product.code, quantity }),
      });
      setNotice(
        `${quantity} adet ${product.name} için aktivasyon talebi satış ekibine iletildi.`,
      );
      await load();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Hat talebi oluşturulamadı.",
      );
    } finally {
      setBusy("");
    }
  }

  return (
    <AppFrame
      title="Abonelik ve Cüzdan"
      subtitle="Planınızı, hat lisanslarını, AI kredilerini ve ödemeleri yönetin."
    >
      {!provider.configured && (
        <div className="billing-banner warning-state">
          Online ödeme henüz yapılandırılmadı. Hat lisanslarını satış onayına
          gönderebilir; plan ve kredi ödemeleri açıldığında buradan satın
          alabilirsiniz.
        </div>
      )}
      {notice && <div className="success-state">{notice}</div>}
      {error && <div className="form-error">{error}</div>}

      <div className="billing-summary-grid">
        <section className="stack-card billing-hero-card">
          <span className="eyebrow">Mevcut abonelik</span>
          <h2>{overview?.entitlement?.display_name ?? "Plan yok"}</h2>
          <div
            className={`billing-status status-${subscription?.status ?? "none"}`}
          >
            {statusLabels[subscription?.status ?? ""] ??
              subscription?.status ??
              "Aktif değil"}
          </div>
          <dl className="billing-definition-list">
            <div>
              <dt>Sağlayıcı</dt>
              <dd>{subscription?.provider ?? "—"}</dd>
            </div>
            <div>
              <dt>Dönem sonu</dt>
              <dd>{date(subscription?.current_period_end ?? null)}</dd>
            </div>
            <div>
              <dt>Deneme sonu</dt>
              <dd>{date(overview?.entitlement?.trial_ends_at ?? null)}</dd>
            </div>
          </dl>
          {subscription?.provider === "paddle" && (
            <button
              className="subtle-button"
              disabled={busy === "portal"}
              onClick={openPortal}
            >
              {busy === "portal" ? "Açılıyor…" : "Ödeme ve faturaları yönet"}
            </button>
          )}
        </section>

        <section className="stack-card">
          <span className="eyebrow">Bu ay kullanım</span>
          <div className="billing-usage-list">
            {(overview?.usage ?? []).length === 0 && (
              <p>Henüz kullanım kaydı yok.</p>
            )}
            {(overview?.usage ?? []).map((item) => {
              const limitValue =
                limits[item.metric] ?? limits[`monthly_${item.metric}`];
              const limit = typeof limitValue === "number" ? limitValue : null;
              const used = number(item.quantity);
              const percent =
                limit === null
                  ? 0
                  : limit === 0
                    ? 100
                    : Math.min(100, (used / limit) * 100);
              return (
                <div key={item.metric}>
                  <div className="billing-usage-heading">
                    <span>{metricLabels[item.metric] ?? item.metric}</span>
                    <strong>
                      {used.toLocaleString("tr-TR")} /{" "}
                      {limit?.toLocaleString("tr-TR") ?? "∞"}
                    </strong>
                  </div>
                  {limit !== null && (
                    <div className="billing-meter">
                      <span style={{ width: `${percent}%` }} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        <section className="stack-card billing-credit-card">
          <span className="eyebrow">AI kredi cüzdanı</span>
          <strong className="billing-credit-balance">
            {number(overview?.credits.balance).toLocaleString("tr-TR")}
          </strong>
          <small>Kredi</small>
          <div className="billing-credit-totals">
            <span>
              Alınan{" "}
              <b>
                {number(overview?.credits.total_purchased).toLocaleString(
                  "tr-TR",
                )}
              </b>
            </span>
            <span>
              Kullanılan{" "}
              <b>
                {number(overview?.credits.total_used).toLocaleString("tr-TR")}
              </b>
            </span>
          </div>
        </section>
      </div>

      <section className="table-card billing-section">
        <div className="billing-section-heading">
          <div>
            <span className="eyebrow">Hat lisansları</span>
            <h2>Aktif ve kullanılabilir kapasite</h2>
          </div>
          <p>Plan hakkınız ile onaylanmış ek hatlar birlikte hesaplanır.</p>
        </div>
        <div className="billing-product-grid">
          {(overview?.lineCapacity ?? []).map((item) => {
            const included =
              item.included == null ? null : number(item.included);
            const licensed =
              included === null ? null : included + number(item.addon);
            const used = number(item.used);
            return (
              <article className="billing-product-card" key={item.family}>
                <span className="billing-product-kind">
                  {item.family === "whatsapp" ? "WhatsApp" : "Telegram"}
                </span>
                <h3>{licensed === null ? "Sınırsız" : `${licensed} lisans`}</h3>
                <p>
                  {used} aktif ·{" "}
                  {licensed === null
                    ? "sınırsız"
                    : Math.max(0, licensed - used)}{" "}
                  kullanılabilir
                </p>
                <small>
                  Plan: {included === null ? "∞" : included} · Ek hat:{" "}
                  {number(item.addon)}
                </small>
              </article>
            );
          })}
        </div>
        {(overview?.salesRequests ?? []).some(
          (item) => item.status === "pending",
        ) && (
          <div className="billing-banner warning-state">
            Bekleyen talep:{" "}
            {(overview?.salesRequests ?? [])
              .filter((item) => item.status === "pending")
              .map((item) => `${item.product_name} × ${item.quantity}`)
              .join(", ")}
          </div>
        )}
      </section>

      <section className="table-card billing-section">
        <div className="billing-section-heading">
          <div>
            <span className="eyebrow">Paketler</span>
            <h2>Plan ve eklentiler</h2>
          </div>
          <p>Vergi ve nihai toplam güvenli ödeme ekranında hesaplanır.</p>
        </div>
        <div className="billing-product-grid">
          {catalog.map((product) => (
            <article className="billing-product-card" key={product.id}>
              <span className="billing-product-kind">
                {product.product_type === "plan"
                  ? "Plan"
                  : product.product_type === "channel"
                    ? "Hat"
                    : product.product_type === "credit"
                      ? "Cüzdan"
                      : "Eklenti"}
              </span>
              <h3>{product.name}</h3>
              {product.product_type === "channel" ? (
                <div className="billing-price-row">
                  <span>
                    {product.prices[0]
                      ? `${money(product.prices[0].unitAmountMinor, product.prices[0].currency)} / ${intervalLabels[product.prices[0].interval]}`
                      : "Satış ekibi fiyatlandırması"}
                  </span>
                  <label>
                    Adet
                    <input
                      aria-label={`${product.name} adedi`}
                      type="number"
                      min={1}
                      max={500}
                      value={lineQuantities[product.code] ?? 1}
                      onChange={(event) =>
                        setLineQuantities((current) => ({
                          ...current,
                          [product.code]: Number(event.target.value) || 1,
                        }))
                      }
                    />
                  </label>
                  <button
                    className="primary-button"
                    disabled={busy === `request-${product.id}`}
                    onClick={() => requestLine(product)}
                  >
                    {busy === `request-${product.id}`
                      ? "Gönderiliyor…"
                      : "Aktivasyon talebi"}
                  </button>
                </div>
              ) : product.prices.length === 0 ? (
                <p className="muted-text">Fiyat henüz yayınlanmadı.</p>
              ) : (
                product.prices.map((price) => (
                  <div className="billing-price-row" key={price.id}>
                    <span>
                      <strong>
                        {money(price.unitAmountMinor, price.currency)}
                      </strong>{" "}
                      / {intervalLabels[price.interval]}
                    </span>
                    {product.product_type === "credit" &&
                    price.creditsPerUnit ? (
                      <span>
                        {number(price.creditsPerUnit).toLocaleString("tr-TR")}{" "}
                        kredi
                      </span>
                    ) : null}
                    <button
                      className="primary-button"
                      disabled={!provider.configured || busy === price.id}
                      onClick={() => buy(price)}
                    >
                      {busy === price.id ? "Açılıyor…" : "Satın al"}
                    </button>
                  </div>
                ))
              )}
            </article>
          ))}
        </div>
      </section>

      <section className="table-card billing-section">
        <div className="billing-section-heading">
          <div>
            <span className="eyebrow">Finans</span>
            <h2>Ödemelerim</h2>
          </div>
        </div>
        {(overview?.transactions ?? []).length === 0 ? (
          <p>Henüz ödeme kaydı yok.</p>
        ) : (
          <div className="responsive-table">
            <table>
              <thead>
                <tr>
                  <th>Tarih</th>
                  <th>Durum</th>
                  <th>Matrah</th>
                  <th>Vergi</th>
                  <th>Toplam</th>
                  <th>Fatura</th>
                </tr>
              </thead>
              <tbody>
                {overview!.transactions.map((item) => (
                  <tr key={item.id}>
                    <td>{date(item.billed_at ?? item.created_at)}</td>
                    <td>{statusLabels[item.status] ?? item.status}</td>
                    <td>{money(item.subtotal_minor, item.currency)}</td>
                    <td>{money(item.tax_minor, item.currency)}</td>
                    <td>
                      <strong>{money(item.total_minor, item.currency)}</strong>
                    </td>
                    <td>{item.invoice_number ?? "Portalda"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </AppFrame>
  );
}
