"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  Activity,
  ArrowUpRight,
  DatabaseZap,
  Link2,
  RefreshCw,
  ShieldCheck,
  Unplug,
  Users,
} from "lucide-react";
import { AppFrame } from "./app-frame";
import {
  bitrixUserDisplayName,
  bitrixUserEmail,
  bitrixUserCrmPolicy,
  buildBitrixUserMappingPayload,
  type BitrixUserCrmPolicy,
} from "./bitrix-user-mapping";
import { apiJson } from "../lib/api";

type Connection = {
  id: string;
  name: string;
  authMode: string;
  portalUrl: string | null;
  authExternalUserId: string | null;
  authExternalUserName: string | null;
  status: string;
  credentialsConfigured: boolean;
  lastHealthAt: string | null;
  lastSyncAt: string | null;
  lastErrorCode: string | null;
  settings: Record<string, unknown>;
};
type Row = Record<string, unknown>;
type OrganizationUser = {
  id: string;
  full_name: string;
  email: string;
  role: string;
  is_active: boolean;
  suspended_at: string | null;
};
type LocalAppSetup = {
  applicationHandlerUrl: string;
  installationCallbackUrl: string;
  eventHandlerUrl: string;
  requiredScopes: string[];
  optionalScopes: string[];
};
const tabs = [
  { href: "/app/integrations/bitrix24", label: "Genel" },
  { href: "/app/integrations/bitrix24/settings", label: "Ayarlar" },
  { href: "/app/integrations/bitrix24/mappings", label: "Alan eşlemeleri" },
  { href: "/app/integrations/bitrix24/users", label: "Kullanıcılar" },
  { href: "/app/integrations/bitrix24/sync", label: "Senkron" },
  { href: "/app/integrations/bitrix24/logs", label: "Loglar" },
  { href: "/app/integrations/bitrix24/open-channels", label: "Open Channels" },
];

export function Bitrix24Workspace() {
  const pathname = usePathname(),
    [items, setItems] = useState<Connection[]>([]),
    [rows, setRows] = useState<Row[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [showConnect, setShowConnect] = useState(false),
    [connectMode, setConnectMode] = useState("local_app"),
    [localAppSetup, setLocalAppSetup] = useState<LocalAppSetup | null>(null),
    [oauthAuthorizationUrl, setOauthAuthorizationUrl] = useState(""),
    [organizationUsers, setOrganizationUsers] = useState<OrganizationUser[]>(
      [],
    ),
    [userMappings, setUserMappings] = useState<Record<string, string>>({}),
    [userCrmPolicies, setUserCrmPolicies] = useState<
      Record<string, BitrixUserCrmPolicy>
    >({}),
    [savingMappings, setSavingMappings] = useState(false);
  const current = items[0];
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await apiJson<{ data: Connection[] }>(
        "/api/v1/integrations",
      );
      setItems(
        result.data.filter(
          (item) =>
            item.portalUrl?.includes("bitrix24") || item.authMode === "fake",
        ),
      );
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Entegrasyonlar yüklenemedi",
      );
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);
  const loadDetail = useCallback(async () => {
    if (!current) {
      setRows([]);
      setOrganizationUsers([]);
      setUserMappings({});
      setUserCrmPolicies({});
      return;
    }
    const endpoint = pathname.endsWith("/users")
      ? "users"
      : pathname.endsWith("/logs")
        ? "logs"
        : pathname.endsWith("/sync")
          ? "jobs"
          : pathname.endsWith("/mappings")
            ? "users"
            : "";
    if (!endpoint) {
      setRows([]);
      return;
    }
    try {
      const [detailResult, usersResult] = await Promise.all([
        apiJson<{ data: Row[] }>(
          `/api/v1/integrations/${current.id}/${endpoint}`,
        ),
        pathname.endsWith("/users")
          ? apiJson<{ data: OrganizationUser[] }>("/api/v1/users")
          : Promise.resolve({ data: [] as OrganizationUser[] }),
      ]);
      setRows(detailResult.data);
      setOrganizationUsers(usersResult.data);
      if (pathname.endsWith("/users")) {
        setUserMappings(
          Object.fromEntries(
            detailResult.data.map((row) => [
              String(row.external_user_id ?? ""),
              row.local_user_id ? String(row.local_user_id) : "",
            ]),
          ),
        );
        setUserCrmPolicies(
          Object.fromEntries(
            detailResult.data.map((row) => [
              String(row.external_user_id ?? ""),
              bitrixUserCrmPolicy(row),
            ]),
          ),
        );
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Detay yüklenemedi");
    }
  }, [current, pathname]);
  useEffect(() => {
    const timer = setTimeout(() => void loadDetail(), 0);
    return () => clearTimeout(timer);
  }, [loadDetail]);
  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      if (form.get("mode") === "oauth") {
        const result = await apiJson<{
          data: { authorizationUrl: string };
        }>("/api/v1/integrations/bitrix24/oauth/start", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: form.get("name"),
            portalUrl: form.get("portalUrl"),
          }),
        });
        setOauthAuthorizationUrl(result.data.authorizationUrl);
      } else if (form.get("mode") === "local_app") {
        const result = await apiJson<{ data: LocalAppSetup }>(
          "/api/v1/integrations/bitrix24/local-app/start",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              name: form.get("name"),
              portalUrl: form.get("portalUrl"),
            }),
          },
        );
        setLocalAppSetup(result.data);
      } else
        await apiJson("/api/v1/integrations/bitrix24/webhook-connect", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: form.get("name"),
            portalUrl: form.get("portalUrl"),
            fakeScenario: form.get("mode") === "fake" ? "success" : undefined,
            webhookUrl:
              form.get("mode") === "webhook"
                ? form.get("webhookUrl")
                : undefined,
            webhookToken: form.get("webhookToken") || undefined,
          }),
        });
      setShowConnect(false);
      setNotice(
        form.get("mode") === "oauth"
          ? "Bitrix24 kullanıcı yetkilendirme bağlantısı hazır."
          : form.get("mode") === "local_app"
            ? "Yerel uygulama kurulumu hazır. Bitrix24 yollarını aşağıdaki değerlerle güncelleyin."
            : "Bitrix24 bağlantısı güvenli şekilde kaydedildi.",
      );
      await load();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Bağlantı kurulamadı",
      );
    }
  }
  async function saveUserMappings() {
    if (!current) return;
    setSavingMappings(true);
    setError("");
    setNotice("");
    try {
      await apiJson(`/api/v1/integrations/${current.id}/user-mappings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          buildBitrixUserMappingPayload(rows, userMappings, userCrmPolicies),
        ),
      });
      setNotice("Bitrix24 kullanıcı eşlemeleri kaydedildi.");
      await loadDetail();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Kullanıcı eşlemeleri kaydedilemedi.",
      );
    } finally {
      setSavingMappings(false);
    }
  }
  async function continueWithFullOAuth() {
    try {
      setError("");
      const result = await apiJson<{ data: { authorizationUrl: string } }>(
        "/api/v1/integrations/bitrix24/oauth/start",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: current?.name ?? "Bitrix24",
            portalUrl:
              current?.portalUrl ?? "https://bahardogan.bitrix24.com.tr",
          }),
        },
      );
      setOauthAuthorizationUrl(result.data.authorizationUrl);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Bitrix24 OAuth başlatılamadı",
      );
    }
  }
  async function action(kind: "test" | "sync" | "users" | "pipelines") {
    if (!current) return;
    setNotice("");
    try {
      const suffix =
        kind === "test"
          ? "test"
          : kind === "sync"
            ? "sync"
            : kind === "users"
              ? "users/sync"
              : "pipelines/sync";
      await apiJson(`/api/v1/integrations/${current.id}/${suffix}`, {
        method: "POST",
      });
      setNotice(
        kind === "test"
          ? "Bitrix24 health testi başarılı."
          : "Senkron işi kabul edildi.",
      );
      if (kind === "users" || kind === "pipelines") await loadDetail();
      else await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "İşlem başarısız");
    }
  }
  async function disconnect() {
    if (
      !current ||
      !confirm(
        "Bitrix24 bağlantısı devre dışı bırakılsın mı? Uzak CRM verileri silinmez.",
      )
    )
      return;
    await apiJson(`/api/v1/integrations/${current.id}`, { method: "DELETE" });
    setNotice("Bağlantı devre dışı bırakıldı; Bitrix24 verileri silinmedi.");
    await load();
  }
  const detailMode =
    pathname.endsWith("/users") ||
    pathname.endsWith("/logs") ||
    pathname.endsWith("/sync") ||
    pathname.endsWith("/mappings");
  return (
    <AppFrame
      title="Bitrix24"
      subtitle="Bitrix24 CRM kaynağını konuşma operasyonlarına bağlayın; CRM verisi Bitrix24'te kalır."
      actions={
        <button
          className="primary-button compact-button"
          onClick={() => setShowConnect(true)}
        >
          <Link2 size={16} />
          Bağlantı ekle
        </button>
      }
    >
      <nav className="settings-tabs integration-tabs">
        {tabs.map((tab) => (
          <Link
            className={pathname === tab.href ? "active" : ""}
            href={tab.href}
            key={tab.href}
          >
            {tab.label}
          </Link>
        ))}
      </nav>
      {notice && <div className="success-state">{notice}</div>}
      {error && <div className="form-error">{error}</div>}
      {localAppSetup && (
        <section className="settings-card">
          <h2>Bitrix24 yerel uygulama kurulumu</h2>
          <p>
            Uygulamayı <strong>Sadece API kullanır</strong> olarak işaretleyin
            ve aşağıdaki yolları kaydedin.
          </p>
          <dl>
            <div>
              <dt>İşleyici yolu</dt>
              <dd>{localAppSetup.applicationHandlerUrl}</dd>
            </div>
            <div>
              <dt>İlk kurulum yolu</dt>
              <dd>{localAppSetup.installationCallbackUrl}</dd>
            </div>
            <div>
              <dt>Olay işleyicisi</dt>
              <dd>{localAppSetup.eventHandlerUrl}</dd>
            </div>
            <div>
              <dt>Zorunlu yetkiler</dt>
              <dd>{localAppSetup.requiredScopes.join(", ")}</dd>
            </div>
          </dl>
          <p className="security-note">
            Bitrix24 ilk kurulum callback&apos;ini göndermiyorsa tam OAuth
            yetkilendirmesiyle güvenli biçimde devam edin.
          </p>
          <button
            className="primary-button"
            onClick={() => void continueWithFullOAuth()}
          >
            Tam OAuth ile bağlan
          </button>
        </section>
      )}
      {oauthAuthorizationUrl && (
        <section className="settings-card">
          <h2>Bitrix24 kullanıcı yetkilendirmesi</h2>
          <p>
            Bağlantının işlemleri hangi Bitrix24 kullanıcısı adına yapacağını
            seçmek için yetkilendirmeyi tamamlayın.
          </p>
          <a className="primary-button" href={oauthAuthorizationUrl}>
            Bitrix24&apos;te yetkilendir
          </a>
        </section>
      )}
      {showConnect && (
        <div className="modal-backdrop">
          <form className="modal-card" onSubmit={connect}>
            <h2>Bitrix24 bağla</h2>
            <label>
              Bağlantı adı
              <input name="name" defaultValue="Bitrix24" required />
            </label>
            <label>
              Portal URL
              <input
                name="portalUrl"
                defaultValue="https://bahardogan.bitrix24.com.tr"
                required
              />
            </label>
            <label>
              Bağlantı tipi
              <select
                name="mode"
                value={connectMode}
                onChange={(event) => setConnectMode(event.target.value)}
              >
                <option value="local_app">OAuth — yerel uygulama</option>
                <option value="oauth">OAuth — ek kullanıcı bağlantısı</option>
                <option value="fake">Fake — yerel kabul</option>
                <option value="webhook">Incoming webhook</option>
              </select>
            </label>
            {connectMode === "webhook" && (
              <>
                <label>
                  Incoming webhook URL
                  <input
                    name="webhookUrl"
                    type="password"
                    autoComplete="off"
                    placeholder="https://portal.bitrix24.com/rest/..."
                  />
                </label>
                <label>
                  Webhook doğrulama tokenı
                  <input
                    name="webhookToken"
                    type="password"
                    autoComplete="off"
                  />
                </label>
              </>
            )}
            <p className="security-note">
              Credential değerleri şifrelenir ve tekrar gösterilmez. Fake mod
              gerçek Bitrix başarısı sayılmaz.
            </p>
            <div className="modal-actions">
              <button type="button" onClick={() => setShowConnect(false)}>
                Vazgeç
              </button>
              <button className="primary-button">Bağla</button>
            </div>
          </form>
        </div>
      )}
      {loading ? (
        <div className="skeleton-grid" />
      ) : !current ? (
        <div className="empty-state">
          <DatabaseZap />
          <h2>Bitrix24 henüz bağlı değil</h2>
          <p>
            OAuth, incoming webhook veya deterministic fake provider ile
            başlayın.
          </p>
          <button
            className="primary-button"
            onClick={() => setShowConnect(true)}
          >
            Bitrix24 bağla
          </button>
        </div>
      ) : (
        <>
          <section className="integration-hero">
            <div>
              <span
                className={`status-pill ${current.status === "connected" ? "healthy" : "warning"}`}
              >
                {current.status}
              </span>
              <h2>{current.name}</h2>
              <p>{current.portalUrl}</p>
              {current.authExternalUserName && (
                <small>
                  Yetkilendiren: {current.authExternalUserName} · kullanıcı{" "}
                  {current.authExternalUserId}
                </small>
              )}
            </div>
            <div className="integration-actions">
              <button onClick={() => void action("test")}>
                <ShieldCheck size={16} />
                Health
              </button>
              <button onClick={() => void action("sync")}>
                <RefreshCw size={16} />
                Tam sync
              </button>
              <button className="danger-link" onClick={() => void disconnect()}>
                <Unplug size={16} />
                Ayır
              </button>
            </div>
          </section>
          {!detailMode && (
            <div className="metrics-grid">
              <article>
                <Activity />
                <span>
                  <small>Bağlantı</small>
                  <strong>{current.authMode}</strong>
                </span>
              </article>
              <article>
                <Users />
                <span>
                  <small>Sorumlu eşleme</small>
                  <strong>
                    {current.settings.syncResponsible === false
                      ? "Kapalı"
                      : "Açık"}
                  </strong>
                </span>
              </article>
              <article>
                <DatabaseZap />
                <span>
                  <small>Timeline</small>
                  <strong>
                    {current.settings.timelineEnabled === false
                      ? "Kapalı"
                      : "Async açık"}
                  </strong>
                </span>
              </article>
            </div>
          )}
          {pathname.endsWith("/settings") && (
            <section className="settings-card">
              <h2>Senkron politikası</h2>
              <p>
                WhatsApp akışı Bitrix24&apos;ten bağımsızdır. Timeline ve
                sorumlu değişiklikleri ayrı CRM kuyruğunda retry edilir.
              </p>
              <dl>
                <div>
                  <dt>Timeline yazımı</dt>
                  <dd>
                    {current.settings.timelineEnabled === false
                      ? "Kapalı"
                      : "Açık"}
                  </dd>
                </div>
                <div>
                  <dt>Çift yönlü sorumlu</dt>
                  <dd>
                    {current.settings.syncResponsible === false
                      ? "Kapalı"
                      : "Açık"}
                  </dd>
                </div>
              </dl>
            </section>
          )}
          {pathname.endsWith("/users") && (
            <div className="inline-action-group">
              <button
                className="secondary-button compact-button inline-action"
                onClick={() => void action("users")}
              >
                <RefreshCw size={15} />
                Bitrix kullanıcılarını senkronize et
              </button>
              <button
                className="primary-button compact-button inline-action"
                disabled={savingMappings || rows.length === 0}
                onClick={() => void saveUserMappings()}
              >
                {savingMappings ? "Kaydediliyor…" : "Eşlemeleri kaydet"}
              </button>
            </div>
          )}
          {pathname.endsWith("/sync") && (
            <button
              className="primary-button compact-button inline-action"
              onClick={() => void action("pipelines")}
            >
              <RefreshCw size={15} />
              Pipeline/stage yenile
            </button>
          )}
          {detailMode && (
            <section className="settings-card integration-table">
              <header>
                <h2>
                  {pathname.endsWith("/logs")
                    ? "Senkron logları"
                    : pathname.endsWith("/sync")
                      ? "CRM işleri"
                      : pathname.endsWith("/users")
                        ? "Kullanıcı eşlemeleri"
                        : "Alan eşlemeleri"}
                </h2>
                <span>{rows.length} kayıt</span>
              </header>
              {rows.length === 0 ? (
                <div className="empty-state compact-empty">
                  Henüz kayıt yok.
                </div>
              ) : pathname.endsWith("/users") ? (
                <div className="bitrix-user-mapping-list">
                  {rows.map((row) => {
                    const externalUserId = String(row.external_user_id ?? "");
                    const usedLocalUserIds = new Set(
                      Object.entries(userMappings)
                        .filter(
                          ([mappedExternalId, localUserId]) =>
                            mappedExternalId !== externalUserId && localUserId,
                        )
                        .map(([, localUserId]) => localUserId),
                    );
                    return (
                      <article key={externalUserId}>
                        <div>
                          <strong>{bitrixUserDisplayName(row)}</strong>
                          <small>
                            {bitrixUserEmail(row) ||
                              `Bitrix ID ${externalUserId}`}
                          </small>
                        </div>
                        <label>
                          <span>Panel hesabı</span>
                          <select
                            value={userMappings[externalUserId] ?? ""}
                            disabled={savingMappings || row.active === false}
                            onChange={(event) =>
                              setUserMappings((currentMappings) => ({
                                ...currentMappings,
                                [externalUserId]: event.target.value,
                              }))
                            }
                          >
                            <option value="">Eşlenmedi</option>
                            {organizationUsers
                              .filter(
                                (user) =>
                                  user.is_active &&
                                  !user.suspended_at &&
                                  (!usedLocalUserIds.has(user.id) ||
                                    userMappings[externalUserId] === user.id),
                              )
                              .map((user) => (
                                <option key={user.id} value={user.id}>
                                  {user.full_name} · {user.email}
                                </option>
                              ))}
                          </select>
                        </label>
                        <label>
                          <span>İlk görüşme CRM kaydı</span>
                          <select
                            value={
                              userCrmPolicies[externalUserId]?.mode ?? "inherit"
                            }
                            disabled={
                              savingMappings ||
                              row.active === false ||
                              !userMappings[externalUserId]
                            }
                            onChange={(event) =>
                              setUserCrmPolicies((currentPolicies) => ({
                                ...currentPolicies,
                                [externalUserId]: {
                                  sourceId:
                                    currentPolicies[externalUserId]?.sourceId ??
                                    "",
                                  mode: event.target
                                    .value as BitrixUserCrmPolicy["mode"],
                                },
                              }))
                            }
                          >
                            <option value="inherit">
                              Kanal ayarını kullan
                            </option>
                            <option value="disabled">Kayıt oluşturma</option>
                            <option value="lead">Lead oluştur</option>
                            <option value="contact_and_deal">
                              Kişi ve anlaşma oluştur
                            </option>
                          </select>
                        </label>
                        <label>
                          <span>CRM kaynak kodu</span>
                          <input
                            value={
                              userCrmPolicies[externalUserId]?.sourceId ?? ""
                            }
                            placeholder="Kanal varsayılanı"
                            maxLength={80}
                            disabled={
                              savingMappings ||
                              row.active === false ||
                              !userMappings[externalUserId] ||
                              (userCrmPolicies[externalUserId]?.mode ??
                                "inherit") === "inherit"
                            }
                            onChange={(event) =>
                              setUserCrmPolicies((currentPolicies) => ({
                                ...currentPolicies,
                                [externalUserId]: {
                                  mode:
                                    currentPolicies[externalUserId]?.mode ??
                                    "inherit",
                                  sourceId: event.target.value,
                                },
                              }))
                            }
                          />
                        </label>
                        <span
                          className={`status-pill ${
                            row.active === false ? "warning" : "healthy"
                          }`}
                        >
                          {row.active === false ? "Pasif" : "Aktif"}
                        </span>
                      </article>
                    );
                  })}
                </div>
              ) : (
                <div className="data-list">
                  {rows.map((row, index) => (
                    <article key={String(row.id ?? index)}>
                      <strong>
                        {String(
                          row.operation ??
                            row.job_type ??
                            (row.external_snapshot as Row)?.name ??
                            row.external_user_id ??
                            row.local_field ??
                            "Kayıt",
                        )}
                      </strong>
                      <span>
                        {String(
                          row.status ??
                            row.level ??
                            row.local_user_name ??
                            row.external_field ??
                            "—",
                        )}
                      </span>
                      <small>
                        {row.created_at
                          ? new Date(String(row.created_at)).toLocaleString(
                              "tr",
                            )
                          : ""}
                      </small>
                    </article>
                  ))}
                </div>
              )}
            </section>
          )}
          {!detailMode && !pathname.endsWith("/settings") && (
            <section className="settings-card">
              <h2>Kaynak-of-truth sınırı</h2>
              <p>
                Kişiler, lead/deal, pipeline, stage ve CRM sorumlusu
                Bitrix24&apos;te yönetilir. Brixchat24 yalnızca bağlantı,
                eşleme, görüntüleme cache&apos;i ve dayanıklı senkron işlerini
                tutar.
              </p>
              <a
                className="primary-button compact-button docs-link"
                href="https://apidocs.bitrix24.com/"
                target="_blank"
                rel="noreferrer"
              >
                Bitrix24 REST dokümantasyonu <ArrowUpRight size={14} />
              </a>
            </section>
          )}
        </>
      )}
    </AppFrame>
  );
}
