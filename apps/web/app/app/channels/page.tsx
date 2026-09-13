"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  AlertTriangle,
  Bot,
  Cloud,
  Instagram,
  KeyRound,
  Layers3,
  Link2,
  Mail,
  MessageCircle,
  MessageSquare,
  Pencil,
  Plus,
  Power,
  QrCode,
  RefreshCw,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  Smartphone,
  Trash2,
  Users,
  Zap,
} from "lucide-react";
import { AppFrame } from "../../../components/app-frame";
import {
  ChannelBitrixBindingDrawer,
  type BitrixBindingsOverview,
} from "../../../components/channel-bitrix-binding-drawer";
import {
  ChannelAccessDrawer,
  type ChannelForAccess,
} from "../../../components/channel-access-drawer";
import { apiJson } from "../../../lib/api";
import {
  channelPlatformLabels,
  channelPlatforms,
  countChannelsByPlatform,
  filterChannelsByPlatform,
  readChannelPlatformFilter,
  shouldPollWhatsAppWebSession,
  writeChannelPlatformFilter,
  type ChannelPlatform,
  type ChannelPlatformFilter,
} from "./channel-platform-filter";
import { channelOperationalWarning } from "./channel-operational-warning";

type Channel = {
  id: string;
  name: string;
  internalName: string;
  description: string | null;
  defaultLanguage: string;
  timezone: string;
  provider: string;
  platform: string;
  phoneNumber: string | null;
  phoneNumberId: string | null;
  businessAccountId: string | null;
  status: string;
  connectionStatus: string;
  healthStatus: string;
  healthState: string;
  healthCode: string | null;
  capabilities: string[];
  providerDefinition: {
    key: string;
    displayName: string;
    availability: string;
    branding: { label: string; color: string; icon: string };
  } | null;
  credentialsConfigured: boolean;
  lastWebhookAt: string | null;
  lastWebhookResult: string | null;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  lastHealthCheckAt: string | null;
  lastHealthError: string | null;
  webhookHealth: "HEALTHY" | "WARNING" | "UNHEALTHY" | "UNKNOWN";
  metrics: {
    openConversations: number;
    inboundMessages: number;
    outboundMessages: number;
  };
  team: {
    name: string | null;
    members: Array<{ id: string; name: string; primary: boolean }>;
  };
  session: {
    status: string;
    qrExpiresAt: string | null;
    lastHeartbeatAt: string | null;
    lastErrorCode: string | null;
  } | null;
};

type ProviderDefinition = {
  key: string;
  provider: string;
  platform: string;
  displayName: string;
  description: string;
  availability:
    "available" | "coming_soon" | "unavailable" | "development_only";
  capabilities: string[];
  isEnabled: boolean;
};

type WebhookSetup = {
  callbackUrl: string;
  verifyToken: string;
  subscriptionConfigured?: boolean;
};

type WhatsAppWebSession = {
  status: string;
  qrCode: string | null;
  qrExpiresAt: string | null;
  phoneNumber: string | null;
  pushName: string | null;
  lastHeartbeatAt: string | null;
  lastConnectedAt: string | null;
  lastDisconnectedAt: string | null;
  lastErrorCode: string | null;
  lastError: string | null;
};

const emptyBitrixOverview: BitrixBindingsOverview = {
  bindings: [],
  connections: [],
};

export default function ChannelsPage() {
  const [items, setItems] = useState<Channel[]>([]);
  const [providers, setProviders] = useState<ProviderDefinition[]>([]);
  const [bitrixOverview, setBitrixOverview] =
    useState<BitrixBindingsOverview>(emptyBitrixOverview);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<Channel | null>(null);
  const [deleting, setDeleting] = useState<Channel | null>(null);
  const [webhookSetup, setWebhookSetup] = useState<WebhookSetup | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [healthFilter, setHealthFilter] = useState("all");
  const [sessionChannel, setSessionChannel] = useState<Channel | null>(null);
  const [bitrixChannel, setBitrixChannel] = useState<Channel | null>(null);
  const [accessChannel, setAccessChannel] = useState<ChannelForAccess | null>(
    null,
  );
  const [pendingBitrixChannel, setPendingBitrixChannel] =
    useState<Channel | null>(null);
  const [session, setSession] = useState<WhatsAppWebSession | null>(null);
  const [platformFilter, setPlatformFilter] =
    useState<ChannelPlatformFilter>("all");

  const load = useCallback(async () => {
    try {
      const [channelResult, providerResult, bitrixResult] = await Promise.all([
        apiJson<{ data: Channel[] }>("/api/v1/channels"),
        apiJson<{ data: ProviderDefinition[] }>("/api/v1/channel-providers"),
        apiJson<{ data: BitrixBindingsOverview }>(
          "/api/v1/channels/bitrix24-bindings",
        ).catch(() => ({ data: emptyBitrixOverview })),
      ]);
      setItems(channelResult.data);
      setProviders(providerResult.data);
      setBitrixOverview(bitrixResult.data);
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Yüklenemedi");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timeout = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timeout);
  }, [load]);

  useEffect(() => {
    const syncFromUrl = () =>
      setPlatformFilter(readChannelPlatformFilter(window.location.search));
    syncFromUrl();
    window.addEventListener("popstate", syncFromUrl);
    return () => window.removeEventListener("popstate", syncFromUrl);
  }, []);

  useEffect(() => {
    const channelId = sessionChannel?.id;
    if (!channelId || !shouldPollWhatsAppWebSession(session?.status)) return;

    let cancelled = false;
    let timeoutId: number | undefined;
    const poll = async () => {
      try {
        const result = await apiJson<{ data: WhatsAppWebSession }>(
          `/api/v1/channels/${channelId}/session`,
        );
        if (cancelled) return;
        setSession(result.data);
        setError("");
        if (result.data.status === "connected") {
          await load();
          if (pendingBitrixChannel?.id === channelId) {
            setSessionChannel(null);
            setPendingBitrixChannel(null);
            setBitrixChannel(pendingBitrixChannel);
          }
          return;
        }
      } catch (reason) {
        if (!cancelled)
          setError(
            reason instanceof Error
              ? reason.message
              : "Oturum bilgisi alınamadı",
          );
      }
      if (!cancelled) timeoutId = window.setTimeout(() => void poll(), 2_000);
    };

    timeoutId = window.setTimeout(() => void poll(), 750);
    return () => {
      cancelled = true;
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    };
  }, [load, pendingBitrixChannel, session?.status, sessionChannel?.id]);

  const platformCounts = countChannelsByPlatform(items);
  const activeChannelCount = items.filter(
    (item) => item.connectionStatus.toLowerCase() === "active",
  ).length;
  const healthyChannelCount = items.filter(
    (item) => item.healthStatus.toLowerCase() === "healthy",
  ).length;
  const mappedChannelCount = bitrixOverview.bindings.filter(
    (item) => item.binding !== null,
  ).length;
  const visibleItems = filterChannelsByPlatform(items, platformFilter).filter(
    (item) => {
      const needle = search.trim().toLocaleLowerCase("tr");
      const matchesSearch =
        !needle ||
        [item.name, item.phoneNumber, item.internalName, item.team.name]
          .filter(Boolean)
          .some((value) =>
            String(value).toLocaleLowerCase("tr").includes(needle),
          );
      const matchesStatus =
        statusFilter === "all" ||
        item.connectionStatus.toLowerCase() === statusFilter;
      const matchesHealth =
        healthFilter === "all" ||
        item.healthStatus.toLowerCase() === healthFilter;
      return matchesSearch && matchesStatus && matchesHealth;
    },
  );
  const providerByPlatform = new Map<ChannelPlatform, ProviderDefinition>();
  for (const platform of channelPlatforms) {
    const candidates = providers.filter((provider) =>
      platform === "whatsapp_web"
        ? provider.provider === "whatsapp_web"
        : provider.platform === platform &&
          provider.provider !== "whatsapp_web",
    );
    const definition =
      candidates.find((provider) => provider.availability === "available") ??
      candidates.find((provider) => provider.availability === "coming_soon") ??
      candidates[0];
    if (definition) providerByPlatform.set(platform, definition);
  }

  function selectPlatform(platform: ChannelPlatformFilter) {
    setPlatformFilter(platform);
    const search = writeChannelPlatformFilter(window.location.search, platform);
    window.history.pushState(null, "", `${window.location.pathname}${search}`);
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setSubmitting(true);
    setError("");
    try {
      const result = await apiJson<{
        data: Channel & { webhookSetup?: WebhookSetup };
      }>("/api/v1/channels", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: form.get("name"),
          internalName: form.get("internalName") || undefined,
          description: form.get("description") || undefined,
          defaultLanguage: form.get("defaultLanguage") || "tr",
          timezone: form.get("timezone") || "Europe/Istanbul",
          provider: form.get("provider"),
          platform: form.get("platform"),
          phoneNumber: form.get("phoneNumber") || undefined,
          phoneNumberId: form.get("phoneNumberId") || undefined,
          businessAccountId: form.get("businessAccountId") || undefined,
          accessToken: form.get("accessToken") || undefined,
          appSecret: form.get("appSecret") || undefined,
        }),
      });
      setShowCreate(false);
      setWebhookSetup(result.data.webhookSetup ?? null);
      if (result.data.provider === "whatsapp_web") {
        if (bitrixOverview.connections.length > 0)
          setPendingBitrixChannel(result.data);
        await openSession(result.data);
      } else if (bitrixOverview.connections.length > 0) {
        setBitrixChannel(result.data);
      }
      setNotice(
        result.data.provider === "whatsapp_web"
          ? "WhatsApp Web kanalı oluşturuldu. Bağlı cihaz oturumu hazırlanıyor."
          : result.data.webhookSetup?.subscriptionConfigured
            ? "Kanal ve Meta webhook aboneliği oluşturuldu."
            : result.data.webhookSetup
              ? "Kanal oluşturuldu. Meta webhook bilgilerini şimdi kaydedin."
              : "Kanal oluşturuldu. Gizli değerler tekrar gösterilmez.",
      );
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Oluşturulamadı");
    } finally {
      setSubmitting(false);
    }
  }

  async function update(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editing) return;
    const form = new FormData(event.currentTarget);
    const accessToken = String(form.get("accessToken") ?? "");
    const appSecret = String(form.get("appSecret") ?? "");
    setSubmitting(true);
    setError("");
    try {
      await apiJson(`/api/v1/channels/${editing.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: form.get("name"),
          internalName: form.get("internalName"),
          description: form.get("description") || null,
          defaultLanguage: form.get("defaultLanguage"),
          timezone: form.get("timezone"),
          ...(editing.platform !== "telegram"
            ? {
                phoneNumber: form.get("phoneNumber"),
                phoneNumberId: form.get("phoneNumberId") || null,
                businessAccountId: form.get("businessAccountId") || null,
              }
            : {}),
        }),
      });
      if (accessToken || appSecret) {
        await apiJson(`/api/v1/channels/${editing.id}/credentials`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ...(accessToken ? { accessToken } : {}),
            ...(appSecret ? { appSecret } : {}),
          }),
        });
      }
      setEditing(null);
      setNotice("Kanal güncellendi.");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Güncellenemedi");
    } finally {
      setSubmitting(false);
    }
  }

  async function remove() {
    if (!deleting) return;
    setSubmitting(true);
    setError("");
    try {
      await apiJson(`/api/v1/channels/${deleting.id}`, { method: "DELETE" });
      setDeleting(null);
      setNotice("Kanal silindi. Geçmiş konuşmalar korunmaya devam edecek.");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Kanal silinemedi");
    } finally {
      setSubmitting(false);
    }
  }

  async function action(id: string, type: "test" | "sync") {
    setNotice("");
    setError("");
    try {
      const result = await apiJson<{
        data: { status?: string; received?: number };
      }>(
        `/api/v1/channels/${id}/${type === "sync" ? "templates/sync" : "test"}`,
        { method: "POST" },
      );
      setNotice(
        type === "test"
          ? `Health sonucu: ${result.data.status}`
          : `${result.data.received} şablon senkronize edildi.`,
      );
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "İşlem başarısız");
    }
  }

  async function setConnection(item: Channel) {
    const enable = item.connectionStatus !== "ACTIVE";
    setNotice("");
    setError("");
    setSubmitting(true);
    try {
      await apiJson(
        `/api/v1/channels/${item.id}/${enable ? "enable" : "disable"}`,
        { method: "POST" },
      );
      setNotice(
        enable
          ? `${item.name} etkinleştirildi.`
          : `${item.name} geçici olarak devre dışı bırakıldı.`,
      );
      await load();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Durum değiştirilemedi",
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function rotateWebhookToken(item: Channel) {
    if (
      !window.confirm(
        `${item.name} için yeni verify token üretilecek. Meta ayarındaki mevcut token, yeni token kaydedilene kadar geçersiz olacaktır. Devam edilsin mi?`,
      )
    )
      return;
    setNotice("");
    setError("");
    setSubmitting(true);
    try {
      const result = await apiJson<{
        data: WebhookSetup & { rotated: boolean };
      }>(`/api/v1/channels/${item.id}/rotate-verify-token`, {
        method: "POST",
      });
      setWebhookSetup(result.data);
      setNotice(
        result.data.subscriptionConfigured
          ? "Meta webhook aboneliği bu kanala yeniden bağlandı."
          : "Yeni Meta webhook verify tokenı oluşturuldu.",
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Token yenilenemedi");
    } finally {
      setSubmitting(false);
    }
  }

  async function openSession(item: Channel) {
    setSessionChannel(item);
    setSession(null);
    setError("");
    try {
      const result = await apiJson<{ data: WhatsAppWebSession }>(
        `/api/v1/channels/${item.id}/session`,
      );
      setSession(result.data);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Oturum bilgisi alınamadı",
      );
    }
  }

  async function sessionAction(action: "reconnect" | "logout") {
    if (!sessionChannel) return;
    if (
      action === "logout" &&
      !window.confirm(
        "Bağlı cihaz oturumu ve Signal anahtarları temizlenecek. Yeniden bağlanmak için QR gerekir. Devam edilsin mi?",
      )
    )
      return;
    setSubmitting(true);
    try {
      await apiJson(`/api/v1/channels/${sessionChannel.id}/session/${action}`, {
        method: "POST",
      });
      await openSession(sessionChannel);
      await load();
      setNotice(
        action === "logout"
          ? "WhatsApp Web oturumu güvenli şekilde kapatıldı."
          : "WhatsApp Web yeniden bağlantı kuyruğuna alındı.",
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "İşlem başarısız");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AppFrame
      title="Kanallar"
      subtitle="Mesajlaşma kanallarınızı tek yerden yönetin."
      actions={
        <button
          className="primary-button compact-button"
          onClick={() => {
            setError("");
            setShowCreate(true);
          }}
        >
          <Plus size={16} />
          Kanal ekle
        </button>
      }
    >
      {notice && <div className="success-state">{notice}</div>}
      {error && <div className="form-error">{error}</div>}

      <section
        className="channels-operations-hero"
        aria-label="Kanal operasyon özeti"
      >
        <div className="channels-operations-copy">
          <span className="eyebrow">Canlı kanal operasyonu</span>
          <h2>Her hattın bağlantısı, sağlığı ve CRM rotası tek görünümde.</h2>
          <p>
            WhatsApp hatlarını birbirinden bağımsız yönetin; Bitrix24 Açık Kanal
            eşlemesini yalnızca siz seçtiğinizde oluşturun veya değiştirin.
          </p>
        </div>
        <div className="channels-operations-stats">
          <article>
            <Layers3 size={18} />
            <span>
              <strong>{loading ? "—" : activeChannelCount}</strong>aktif kanal
            </span>
          </article>
          <article>
            <ShieldCheck size={18} />
            <span>
              <strong>{loading ? "—" : healthyChannelCount}</strong>sağlıklı hat
            </span>
          </article>
          <article>
            <Link2 size={18} />
            <span>
              <strong>{loading ? "—" : mappedChannelCount}</strong>Bitrix
              eşlemesi
            </span>
          </article>
        </div>
      </section>

      <nav className="channel-platform-bar" aria-label="Kanal platformları">
        <button
          type="button"
          className={platformFilter === "all" ? "active" : ""}
          aria-pressed={platformFilter === "all"}
          onClick={() => selectPlatform("all")}
        >
          <Layers3 size={22} />
          <span>Tümü</span>
          <strong>{items.length}</strong>
        </button>
        {channelPlatforms.map((platform) => {
          const definition = providerByPlatform.get(platform);
          if (!definition) return null;
          const comingSoon =
            definition.availability === "coming_soon" &&
            platformCounts[platform] === 0;
          return (
            <button
              key={platform}
              type="button"
              className={platformFilter === platform ? "active" : ""}
              aria-pressed={platformFilter === platform}
              disabled={comingSoon}
              onClick={() => selectPlatform(platform)}
            >
              <PlatformIcon platform={platform} />
              <span>{channelPlatformLabels[platform]}</span>
              <strong>{platformCounts[platform]}</strong>
              {comingSoon && <em>Yakında</em>}
            </button>
          );
        })}
      </nav>

      {webhookSetup && (
        <div className="modal-backdrop" role="presentation">
          <section
            className="modal-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="webhook-setup-title"
          >
            <h2 id="webhook-setup-title">Meta webhook kurulumu</h2>
            <p className="security-note">
              {webhookSetup.subscriptionConfigured
                ? "Webhook bu WABA için otomatik olarak bağlandı. Aşağıdaki bilgiler yalnızca yeniden kurulum gerekirse kullanılmalıdır."
                : "Verify token yalnızca bu kez gösterilir. Callback URL ve tokenı Meta Developers webhook ayarlarına girin."}
            </p>
            <label>
              Callback URL
              <input value={webhookSetup.callbackUrl} readOnly />
            </label>
            <label>
              Verify token
              <input value={webhookSetup.verifyToken} readOnly />
            </label>
            <div className="modal-actions">
              <button
                type="button"
                className="primary-button"
                onClick={() => setWebhookSetup(null)}
              >
                Kurulumu tamamladım
              </button>
            </div>
          </section>
        </div>
      )}

      {sessionChannel && (
        <div className="modal-backdrop" role="presentation">
          <section
            className="modal-card channel-session-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="wa-web-session-title"
          >
            <header>
              <div>
                <p className="eyebrow">Bağlı cihaz oturumu</p>
                <h2 id="wa-web-session-title">{sessionChannel.name}</h2>
              </div>
              <span className={`status-pill ${session?.status ?? "loading"}`}>
                {session?.status ?? "Yükleniyor"}
              </span>
            </header>
            <div className="wa-web-risk-note">
              <AlertTriangle size={20} />
              <p>
                WhatsApp Web, Meta’nın resmî Business Platform API’si değildir.
                Telefon bağlantısı, yeniden QR isteme, oturum kopması veya hesap
                kısıtlanması gibi operasyonel riskler bulunabilir.
              </p>
            </div>
            {session?.qrCode ? (
              <div className="wa-web-qr">
                {/* QR data URL is short-lived and returned only to authorized users. */}
                <Image
                  src={session.qrCode}
                  alt="WhatsApp Web bağlantı QR kodu"
                  width={320}
                  height={320}
                  unoptimized
                />
                <p>WhatsApp → Bağlı cihazlar ekranından bu kodu okutun.</p>
              </div>
            ) : (
              <div className="wa-web-session-state">
                <QrCode size={38} />
                <strong>
                  {session?.status === "connected"
                    ? "Cihaz bağlı"
                    : "QR kodu hazırlanıyor"}
                </strong>
                <span>
                  {session?.phoneNumber ??
                    session?.lastError ??
                    "Worker oturumu devraldığında QR burada görünecek."}
                </span>
              </div>
            )}
            <dl className="session-facts">
              <div>
                <dt>Bağlantı yöntemi</dt>
                <dd>Baileys · bağlı cihaz</dd>
              </div>
              <div>
                <dt>Son heartbeat</dt>
                <dd>{formatRelativeTime(session?.lastHeartbeatAt)}</dd>
              </div>
            </dl>
            <div className="modal-actions">
              <button type="button" onClick={() => setSessionChannel(null)}>
                Kapat
              </button>
              <button
                type="button"
                disabled={submitting}
                onClick={() => void sessionAction("logout")}
              >
                Oturumu kapat
              </button>
              <button
                type="button"
                className="primary-button"
                disabled={submitting}
                onClick={() => void sessionAction("reconnect")}
              >
                <RefreshCw size={15} /> Yeniden bağlan
              </button>
            </div>
          </section>
        </div>
      )}

      {bitrixChannel && (
        <ChannelBitrixBindingDrawer
          channel={bitrixChannel}
          overview={bitrixOverview}
          onClose={() => setBitrixChannel(null)}
          onChanged={load}
        />
      )}

      {accessChannel && (
        <ChannelAccessDrawer
          channel={accessChannel}
          onClose={() => setAccessChannel(null)}
          onChanged={load}
        />
      )}

      {showCreate && (
        <div className="modal-backdrop" role="presentation">
          <form className="modal-card" onSubmit={create}>
            <h2>Kanal ekle</h2>
            <ChannelFields providers={providers} />
            <p className="security-note">
              Gizli değerler AES-256-GCM ile şifrelenir ve API yanıtlarında
              dönmez.
            </p>
            <div className="modal-actions">
              <button type="button" onClick={() => setShowCreate(false)}>
                Vazgeç
              </button>
              <button className="primary-button" disabled={submitting}>
                {submitting ? "Oluşturuluyor…" : "Oluştur"}
              </button>
            </div>
          </form>
        </div>
      )}

      {editing && (
        <div className="modal-backdrop" role="presentation">
          <form className="modal-card" onSubmit={update}>
            <h2>Kanalı düzenle</h2>
            <label>
              Kanal adı
              <input name="name" defaultValue={editing.name} required />
            </label>
            <label>
              İç isim
              <input
                name="internalName"
                defaultValue={editing.internalName}
                required
              />
            </label>
            <label>
              Açıklama
              <textarea
                name="description"
                defaultValue={editing.description ?? ""}
                maxLength={500}
              />
            </label>
            <label>
              Provider
              <input value={editing.provider} disabled />
            </label>
            {editing.platform !== "telegram" && (
              <>
                <label>
                  Telefon
                  <input
                    name="phoneNumber"
                    defaultValue={editing.phoneNumber ?? ""}
                    required
                  />
                </label>
                <div className="form-row">
                  <label>
                    Phone Number ID
                    <input
                      name="phoneNumberId"
                      defaultValue={editing.phoneNumberId ?? ""}
                    />
                  </label>
                  <label>
                    Business Account ID
                    <input
                      name="businessAccountId"
                      defaultValue={editing.businessAccountId ?? ""}
                    />
                  </label>
                </div>
              </>
            )}
            <div className="form-row">
              <label>
                Varsayılan dil
                <input
                  name="defaultLanguage"
                  defaultValue={editing.defaultLanguage}
                  required
                />
              </label>
              <label>
                Saat dilimi
                <input
                  name="timezone"
                  defaultValue={editing.timezone}
                  required
                />
              </label>
            </div>
            {editing.platform !== "telegram" && (
              <>
                <label>
                  Yeni access token
                  <input
                    name="accessToken"
                    type="password"
                    autoComplete="new-password"
                    placeholder="Değiştirmek istemiyorsanız boş bırakın"
                  />
                </label>
                <label>
                  Yeni app secret
                  <input
                    name="appSecret"
                    type="password"
                    autoComplete="new-password"
                    placeholder="Değiştirmek istemiyorsanız boş bırakın"
                  />
                </label>
              </>
            )}
            <p className="security-note">
              {editing.platform === "telegram"
                ? "Bot token değişikliği webhook kimliğini de değiştirir; bunun için kanalı silip yeniden bağlayın."
                : "Mevcut gizli değerler gösterilmez. Yalnızca değiştirmek istediğiniz alanı doldurun."}
            </p>
            <div className="modal-actions">
              <button type="button" onClick={() => setEditing(null)}>
                Vazgeç
              </button>
              <button className="primary-button" disabled={submitting}>
                {submitting ? "Kaydediliyor…" : "Kaydet"}
              </button>
            </div>
          </form>
        </div>
      )}

      {deleting && (
        <div className="modal-backdrop" role="presentation">
          <section
            className="modal-card confirmation-card"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="delete-channel-title"
          >
            <h2 id="delete-channel-title">Kanalı silmek istiyor musunuz?</h2>
            <p>
              <strong>{deleting.name}</strong> listeden kaldırılacak, bağlantısı
              kapatılacak ve kayıtlı gizli değerleri temizlenecek. Geçmiş
              konuşmalar korunacak.
            </p>
            <div className="modal-actions">
              <button type="button" onClick={() => setDeleting(null)}>
                Vazgeç
              </button>
              <button
                type="button"
                className="primary-button destructive-button"
                disabled={submitting}
                onClick={() => void remove()}
              >
                {submitting ? "Siliniyor…" : "Kanalı sil"}
              </button>
            </div>
          </section>
        </div>
      )}

      <section className="channels-center" aria-labelledby="channel-list-title">
        <header className="channels-section-header">
          <div>
            <h2 id="channel-list-title">
              {platformFilter === "all"
                ? "Tüm kanallar"
                : `${channelPlatformLabels[platformFilter]} kanalları`}
            </h2>
            <span>{visibleItems.length} kanal</span>
          </div>
        </header>
        <div className="channels-toolbar">
          <label className="channels-search">
            <Search size={18} />
            <span className="sr-only">Kanal ara</span>
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Kanal adı veya telefon ara"
            />
          </label>
          <select
            aria-label="Bağlantı durumu"
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value)}
          >
            <option value="all">Durum</option>
            <option value="active">Aktif</option>
            <option value="disconnected">Bağlı değil</option>
            <option value="archived">Arşiv</option>
          </select>
          <select
            aria-label="Kanal sağlığı"
            value={healthFilter}
            onChange={(event) => setHealthFilter(event.target.value)}
          >
            <option value="all">Sağlık</option>
            <option value="healthy">Sağlıklı</option>
            <option value="warning">Uyarı</option>
            <option value="unhealthy">Sağlıksız</option>
            <option value="configuration_required">Yapılandırma gerekli</option>
          </select>
        </div>

        {loading ? (
          <div className="skeleton-grid" />
        ) : items.length === 0 ? (
          <div className="empty-state">
            <ShieldCheck />
            <h2>Henüz kanal yok</h2>
            <p>Cloud API veya bağlı cihaz WhatsApp kanalınızı ekleyin.</p>
          </div>
        ) : visibleItems.length === 0 ? (
          <div className="empty-state">
            <Search />
            <h2>Filtreye uyan kanal yok</h2>
            <p>Arama, durum veya sağlık filtresini değiştirin.</p>
          </div>
        ) : (
          <>
            <div className="channel-list-head" aria-hidden="true">
              <span>Kanal türü ve adı</span>
              <span>Kanal durumu</span>
              <span>Bitrix24 Open Channel</span>
              <span>Son aktivite</span>
              <span>Ayarlar</span>
            </div>
            <div className="channel-cards list">
              {visibleItems.map((item) => {
                const operationalWarning = channelOperationalWarning(item);
                const lastEvent =
                  item.provider === "whatsapp_web"
                    ? (item.session?.lastHeartbeatAt ??
                      item.lastInboundAt ??
                      item.lastOutboundAt)
                    : item.lastWebhookAt;
                const bitrixItem = bitrixOverview.bindings.find(
                  (binding) => binding.channelId === item.id,
                );
                const bitrixBinding = bitrixItem?.binding ?? null;
                return (
                  <article className="channel-card" key={item.id}>
                    <div className="channel-card-row compact">
                      <div className="channel-brand-icon">
                        <PlatformIcon
                          platform={item.platform as ChannelPlatform}
                        />
                      </div>
                      <div className="channel-identity">
                        <h3>{item.name}</h3>
                        <strong>
                          {item.phoneNumber ??
                            (item.platform === "telegram"
                              ? "Bot kimliği bekleniyor"
                              : "Numara bekleniyor")}
                        </strong>
                        <p>
                          {item.platform === "telegram" ? (
                            <Send size={14} />
                          ) : item.provider === "whatsapp_web" ? (
                            <button
                              type="button"
                              className="channel-session-trigger"
                              aria-label={`${item.name} QR kodu ve oturum bilgileri`}
                              title="QR kodu ve oturum bilgileri"
                              onClick={() => void openSession(item)}
                            >
                              <QrCode size={14} />
                            </button>
                          ) : (
                            <Cloud size={14} />
                          )}
                          {item.platform === "telegram"
                            ? "Telegram Bot API"
                            : item.provider === "whatsapp_web"
                            ? "WhatsApp Web · Bağlı cihaz"
                            : "WhatsApp Cloud API"}
                        </p>
                      </div>
                      <div className="channel-badges">
                        <span
                          className={`status-pill ${
                            item.connectionStatus === "ACTIVE"
                              ? "healthy"
                              : "warning"
                          }`}
                        >
                          {item.connectionStatus === "ACTIVE"
                            ? "Aktif"
                            : "Bağlı değil"}
                        </span>
                        <span className={`status-pill ${item.healthStatus}`}>
                          {healthLabel(item.healthStatus)}
                        </span>
                      </div>
                      <div className="channel-bitrix-mapping">
                        <span
                          className={`channel-bitrix-state ${
                            bitrixBinding?.status ?? "unmapped"
                          }`}
                        >
                          {bitrixBinding?.status === "active"
                            ? "Eşlendi"
                            : bitrixBinding
                              ? "Kontrol gerekli"
                              : "Eşlenmedi"}
                        </span>
                        <strong>
                          {bitrixItem?.connection?.name ??
                            "Bitrix24 bağlantısı seçilmedi"}
                        </strong>
                        <small>
                          {bitrixBinding
                            ? `Open Channel · Line ${bitrixBinding.lineId}`
                            : "Her hat için ayrı Open Channel seçin"}
                        </small>
                      </div>
                      <div className="channel-last-event">
                        <span>
                          {item.provider === "whatsapp_web"
                            ? "Son oturum sinyali"
                            : "Son webhook"}
                        </span>
                        <strong>
                          <i className={operationalWarning ? "warning" : ""} />
                          {formatRelativeTime(lastEvent)}
                        </strong>
                      </div>
                      <div className="channel-actions">
                        <Link
                          href="/app/ai-chats"
                          aria-label={`${item.name} AI ayarları`}
                          title="AI Chats"
                        >
                          <Bot size={18} />
                        </Link>
                        <Link
                          href="/app/automations"
                          aria-label={`${item.name} otomasyonları`}
                          title="Otomasyonlar"
                        >
                          <Zap size={18} />
                        </Link>
                        <button
                          type="button"
                          aria-label={`${item.name} kullanıcı erişimi`}
                          title="Kullanabilecek kişiler"
                          onClick={() => setAccessChannel(item)}
                        >
                          <Users size={18} />
                        </button>
                        <button
                          type="button"
                          className="channel-settings-button"
                          aria-label={`${item.name} Bitrix24 kanal ayarları`}
                          title="Bitrix24 kanal ayarları"
                          onClick={() => setBitrixChannel(item)}
                        >
                          <Settings2 size={20} />
                        </button>
                        {item.provider !== "whatsapp_web" && (
                          <button
                            type="button"
                            aria-label="Kanalı düzenle"
                            title="Kanalı düzenle"
                            onClick={() => setEditing(item)}
                          >
                            <Pencil size={18} />
                          </button>
                        )}
                        <button
                          type="button"
                          aria-label="Health testi"
                          title="WhatsApp sağlık testi"
                          onClick={() => void action(item.id, "test")}
                        >
                          <ShieldCheck size={17} />
                        </button>
                        <button
                          type="button"
                          aria-label={`${item.name} kanalını sil`}
                          title="Kanalı sil"
                          onClick={() => setDeleting(item)}
                        >
                          <Trash2 size={17} />
                        </button>
                      </div>
                    </div>
                    {operationalWarning && (
                      <div className="channel-warning">
                        <AlertTriangle size={18} />
                        <span>{operationalWarning}</span>
                        <button
                          type="button"
                          onClick={() =>
                            item.provider === "whatsapp_web"
                              ? void openSession(item)
                              : void action(item.id, "test")
                          }
                        >
                          {item.provider === "whatsapp_web"
                            ? "Oturum detayları"
                            : "Health testini çalıştır"}
                        </button>
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          </>
        )}
      </section>
    </AppFrame>
  );
}

function ChannelFields({ providers }: { providers: ProviderDefinition[] }) {
  const selectable = providers.filter(
    (provider) =>
      provider.availability === "available" ||
      provider.availability === "development_only",
  );
  const [definitionKey, setDefinitionKey] = useState(
    selectable[0]?.key ?? "meta_whatsapp_cloud",
  );
  const selected =
    providers.find((provider) => provider.key === definitionKey) ??
    selectable[0] ??
    ({
      key: "meta_whatsapp_cloud",
      provider: "meta",
      platform: "whatsapp",
    } as ProviderDefinition);
  const metaRequired =
    selected.provider === "meta" && selected.platform === "whatsapp";
  const telegramRequired = selected.provider === "telegram";
  return (
    <>
      <label>
        Kanal adı
        <input name="name" required />
      </label>
      <label>
        İç isim
        <input name="internalName" placeholder="Örn. canada_sales" required />
      </label>
      <label>
        Açıklama
        <textarea
          name="description"
          maxLength={500}
          placeholder="Bu kanalın ekip içindeki kullanım amacı"
        />
      </label>
      <label>
        Kanal türü
        <select
          value={definitionKey}
          onChange={(event) => setDefinitionKey(event.target.value)}
        >
          {selectable.map((provider) => (
            <option key={provider.key} value={provider.key}>
              {provider.displayName}
            </option>
          ))}
        </select>
      </label>
      <input name="provider" type="hidden" value={selected.provider} />
      <input name="platform" type="hidden" value={selected.platform} />
      {selected.provider === "meta" ? (
        <div className="provider-choice-note official">
          <Cloud size={20} />
          <p>
            <strong>WhatsApp Cloud API</strong>
            Meta’nın resmî işletme mesajlaşma çözümüdür. Webhook, şablon ve
            delivery status akışları Meta Business Platform üzerinden çalışır.
          </p>
        </div>
      ) : selected.provider === "fake" ? (
        <div className="provider-choice-note warning">
          <AlertTriangle size={20} />
          <p>
            <strong>Yerel test sağlayıcısı</strong>
            Yalnızca geliştirme ve otomatik kabul testlerinde kullanılabilir;
            gerçek mesaj göndermez.
          </p>
        </div>
      ) : selected.provider === "telegram" ? (
        <div className="provider-choice-note official">
          <Send size={20} />
          <p>
            <strong>Telegram Bot API</strong>
            BotFather tarafından verilen token ile özel sohbetlerde metin
            mesajları ve güvenli webhook akışı etkinleştirilir.
          </p>
        </div>
      ) : (
        <div className="provider-choice-note warning">
          <AlertTriangle size={20} />
          <p>
            <strong>WhatsApp Web · bağlı cihaz</strong>
            Resmî Cloud API değildir. Oturum kopabilir, yeniden QR veya telefon
            bağlantısı gerekebilir ve hesap kısıtlanması riski bulunabilir.
          </p>
        </div>
      )}
      {providers.some(
        (provider) => provider.availability === "coming_soon",
      ) && (
        <p className="security-note">
          {providers
            .filter((provider) => provider.availability === "coming_soon")
            .map((provider) => provider.displayName)
            .join(", ")}{" "}
          yakında kullanıma açılacak. Gerçek adapter hazır olmadan
          etkinleştirilemez.
        </p>
      )}
      {!telegramRequired && (
        <label>
          Telefon
          <input
            name="phoneNumber"
            placeholder={
              metaRequired
                ? "+905551234567"
                : "Bağlantıdan sonra otomatik alınır"
            }
            required={metaRequired}
          />
        </label>
      )}
      {metaRequired && (
        <>
          <div className="form-row">
            <label>
              Phone Number ID
              <input name="phoneNumberId" required />
            </label>
            <label>
              Business Account ID
              <input name="businessAccountId" required />
            </label>
          </div>
          <label>
            Access token
            <input
              name="accessToken"
              type="password"
              autoComplete="new-password"
              required
            />
          </label>
          <label>
            App secret
            <input
              name="appSecret"
              type="password"
              autoComplete="new-password"
            />
          </label>
        </>
      )}
      {telegramRequired && (
        <label>
          Bot token
          <input
            name="accessToken"
            type="password"
            autoComplete="new-password"
            required
          />
        </label>
      )}
      <div className="form-row">
        <label>
          Varsayılan dil
          <input name="defaultLanguage" defaultValue="tr" required />
        </label>
        <label>
          Saat dilimi
          <input name="timezone" defaultValue="Europe/Istanbul" required />
        </label>
      </div>
    </>
  );
}

function PlatformIcon({ platform }: { platform: ChannelPlatform }) {
  const props = { size: 23, "aria-hidden": true } as const;
  if (platform === "whatsapp_web") return <QrCode {...props} />;
  if (platform === "instagram") return <Instagram {...props} />;
  if (platform === "messenger") return <MessageCircle {...props} />;
  if (platform === "telegram") return <Send {...props} />;
  if (platform === "sms") return <Smartphone {...props} />;
  if (platform === "email") return <Mail {...props} />;
  if (platform === "web_chat") return <MessageSquare {...props} />;
  return <MessageCircle {...props} />;
}

function formatRelativeTime(value?: string | null): string {
  if (!value) return "Henüz yok";
  const elapsed = Math.max(0, Date.now() - new Date(value).getTime());
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "şimdi";
  if (minutes < 60) return `${minutes} dk önce`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} sa önce`;
  return `${Math.floor(hours / 24)} gün önce`;
}

function healthLabel(status: string): string {
  if (status === "healthy") return "Sağlıklı";
  if (status === "warning") return "Uyarı";
  if (status === "unhealthy") return "Sağlıksız";
  return "Kontrol gerekli";
}
