"use client";

import type { FormEvent, ReactNode } from "react";
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Activity,
  AlertTriangle,
  Building2,
  ChevronRight,
  CreditCard,
  Gauge,
  LayoutDashboard,
  LogOut,
  Menu,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  Users,
  X,
} from "lucide-react";
import { apiFetch, apiJson, logout } from "../../../lib/api";

export type Row = Record<string, unknown>;
export type PageResponse = {
  data: Row[];
  page: { total: number; limit: number; offset: number };
};
const nav = [
  ["/platform-admin", "Genel bakış", LayoutDashboard],
  ["/platform-admin/organizations", "Firmalar", Building2],
  ["/platform-admin/users", "Kullanıcılar", Users],
  ["/platform-admin/billing", "Abonelik", CreditCard],
  ["/platform-admin/operations", "Operasyon", Activity],
  ["/platform-admin/alerts", "Uyarılar", AlertTriangle],
  ["/platform-admin/audit", "Denetim", ShieldCheck],
  ["/platform-admin/settings", "Ayarlar", Settings],
] as const;

export function PlatformAdminShell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const [state, setState] = useState<"loading" | "ready" | "denied">("loading");
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    void apiJson<{ data: { platformAdmin?: boolean } }>("/api/v1/auth/me")
      .then(({ data }) => setState(data.platformAdmin ? "ready" : "denied"))
      .catch(() => setState("denied"));
  }, []);
  if (state === "loading")
    return <AdminSkeleton label="Yönetim merkezi hazırlanıyor" />;
  if (state === "denied")
    return (
      <main className="pa-gate">
        <h1>Erişim yok</h1>
        <p>Bu alan yalnızca platform sahibine açıktır.</p>
        <Link href="/app/inbox">Uygulamaya dön</Link>
      </main>
    );
  return (
    <div className="pa-shell">
      <a className="skip-link" href="#platform-admin-content">
        Ana içeriğe geç
      </a>
      <aside className={`pa-sidebar ${mobile ? "open" : ""}`}>
        <div className="pa-brand">
          <span>B24</span>
          <div>
            <strong>Brixchat24</strong>
            <small>Platform merkezi</small>
          </div>
          <button aria-label="Menüyü kapat" onClick={() => setMobile(false)}>
            <X size={20} />
          </button>
        </div>
        <nav aria-label="Platform yönetimi">
          {nav.map(([href, label, Icon]) => {
            const active =
              href === "/platform-admin"
                ? path === href
                : path.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                className={active ? "active" : ""}
                onClick={() => setMobile(false)}
              >
                <Icon size={18} />
                <span>{label}</span>
              </Link>
            );
          })}
        </nav>
        <button className="pa-logout" onClick={() => void logout()}>
          <LogOut size={18} />
          Çıkış yap
        </button>
      </aside>
      {mobile && (
        <button
          className="pa-scrim"
          aria-label="Menüyü kapat"
          onClick={() => setMobile(false)}
        />
      )}
      <main id="platform-admin-content" className="pa-main">
        <button className="pa-mobile-menu" onClick={() => setMobile(true)}>
          <Menu size={20} /> Menü
        </button>
        {children}
      </main>
    </div>
  );
}

export function PageHeader({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <header className="pa-page-header">
      <div>
        <p>Platform operasyonu</p>
        <h1>{title}</h1>
        <span>{description}</span>
      </div>
      {action}
    </header>
  );
}
export function AdminSkeleton({
  label = "Veriler yükleniyor",
}: {
  label?: string;
}) {
  return (
    <main className="pa-loading" aria-live="polite">
      <RefreshCw className="spin" size={22} />
      <span>{label}</span>
    </main>
  );
}
export function ErrorState({
  message,
  retry,
}: {
  message: string;
  retry: () => void;
}) {
  return (
    <div className="pa-state error" role="alert">
      <AlertTriangle />
      <div>
        <strong>Veriler alınamadı</strong>
        <p>{message}</p>
      </div>
      <button onClick={retry}>Tekrar dene</button>
    </div>
  );
}
export function Empty({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="pa-empty">
      <Gauge size={30} />
      <strong>{title}</strong>
      <p>{detail}</p>
    </div>
  );
}
export function useLoad<T>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let active = true;
    void apiJson<{ data: T }>(path)
      .then((r) => {
        if (active) {
          setError("");
          setData(r.data);
        }
      })
      .catch((e: Error) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [path, tick]);
  return { data, error, retry: () => setTick((v) => v + 1), setData };
}
function usePageLoad(path: string) {
  const [data, setData] = useState<PageResponse | null>(null);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let active = true;
    void apiJson<PageResponse>(path)
      .then((response) => {
        if (active) {
          setError("");
          setData(response);
        }
      })
      .catch((failure: Error) => active && setError(failure.message));
    return () => {
      active = false;
    };
  }, [path, tick]);
  return { data, error, retry: () => setTick((value) => value + 1) };
}
export const n = (v: unknown) => Number(v ?? 0).toLocaleString("tr-TR");
export const dt = (v: unknown) =>
  v
    ? new Intl.DateTimeFormat("tr-TR", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(String(v)))
    : "—";
const labels: Record<string, string> = {
  active: "Aktif",
  pending_review: "Onay bekliyor",
  disabled: "Devre dışı",
  rejected: "Reddedildi",
  healthy: "Sağlıklı",
  attention: "İzlenmeli",
  critical: "Kritik",
  suspended: "Askıda",
  unverified: "Doğrulanmamış",
  open: "Açık",
  acknowledged: "Onaylandı",
  resolved: "Çözüldü",
  warning: "Uyarı",
  info: "Bilgi",
};
export const Status = ({ value }: { value: unknown }) => (
  <span className={`pa-status ${String(value)}`}>
    {labels[String(value)] ?? String(value ?? "—")}
  </span>
);

export function DashboardPage() {
  const [w, setW] = useState<"7d" | "30d">("7d");
  const { data, error, retry } = useLoad<Row>(
    `/api/v1/platform-admin/overview?window=${w}`,
  );
  return (
    <>
      <PageHeader
        title="Operasyon merkezi"
        description="Platform sağlığı, büyüme ve müdahale gerektiren sinyaller."
        action={
          <div className="pa-segment">
            <button
              className={w === "7d" ? "active" : ""}
              onClick={() => setW("7d")}
            >
              7 gün
            </button>
            <button
              className={w === "30d" ? "active" : ""}
              onClick={() => setW("30d")}
            >
              30 gün
            </button>
          </div>
        }
      />
      {!data && !error ? (
        <AdminSkeleton />
      ) : error ? (
        <ErrorState message={error} retry={retry} />
      ) : (
        <DashboardContent data={data!} />
      )}
    </>
  );
}
function DashboardContent({ data }: { data: Row }) {
  const o = data.organizations as Row,
    u = data.users as Row,
    c = data.channels as Row,
    a = data.alerts as Row,
    b = data.billing as Row,
    k = data.campaigns as Row;
  const cards: Array<[string, unknown, string]> = [
    ["Onay bekleyen", o.pending_review, "pending"],
    ["Aktif firma", o.active, "good"],
    ["Devre dışı", o.disabled, "neutral"],
    ["Aktif kullanıcı", u.active, "good"],
    ["Kritik kanal", c.critical, "critical"],
    ["Açık uyarı", a.open, "warning"],
    ["Biten deneme", b.trials_ending, "warning"],
    ["Ödeme takibi", b.payment_attention, "critical"],
  ];
  return (
    <div className="pa-dashboard">
      <section className="pa-kpi-grid">
        {cards.map(([l, v, t]) => (
          <article key={String(l)} className={`pa-kpi ${t}`}>
            <span>{String(l)}</span>
            <strong>{n(v)}</strong>
          </article>
        ))}
      </section>
      <div className="pa-grid-2">
        <section className="pa-panel">
          <PanelHead
            title="Firma ve kullanıcı eğilimi"
            sub="Seçili dönemdeki günlük hareket"
          />
          <Trend rows={(data.trends as Row[]) ?? []} />
        </section>
        <section className="pa-panel">
          <PanelHead
            title="Dikkat gerektirenler"
            sub="Operasyon ve gelir sinyalleri"
            link="/platform-admin/alerts"
          />
          <ul className="pa-signal-list">
            <li>
              <span>Kritik uyarılar</span>
              <strong>{n(a.critical)}</strong>
            </li>
            <li>
              <span>24 saati aşan onaylar</span>
              <strong>{n(o.overdue_approvals)}</strong>
            </li>
            <li>
              <span>Başarısız webhook</span>
              <strong>{n(b.failed_webhooks)}</strong>
            </li>
            <li>
              <span>Bekleyen hat talepleri</span>
              <strong>{n(b.pending_line_requests)}</strong>
            </li>
          </ul>
        </section>
        <section className="pa-panel">
          <PanelHead
            title="Kanal sağlığı"
            sub="İçerik göstermeyen bağlantı özeti"
            link="/platform-admin/operations"
          />
          <div className="pa-health-row">
            <Health label="Sağlıklı" value={c.healthy} />
            <Health label="İzlenmeli" value={c.attention} />
            <Health label="Kritik" value={c.critical} />
          </div>
        </section>
        <section className="pa-panel">
          <PanelHead
            title="Kampanya teslimatı"
            sub="Son dönemdeki toplu metrikler"
          />
          <div className="pa-big-stat">
            <strong>
              {Number(k.recipients)
                ? `%${((Number(k.failed_recipients) / Number(k.recipients)) * 100).toFixed(1)}`
                : "%0"}
            </strong>
            <span>Başarısız alıcı oranı</span>
          </div>
          <p className="pa-footnote">
            {n(k.total)} kampanya · {n(k.recipients)} alıcı
          </p>
        </section>
      </div>
    </div>
  );
}
function PanelHead({
  title,
  sub,
  link,
}: {
  title: string;
  sub?: string;
  link?: string;
}) {
  return (
    <div className="pa-panel-head">
      <div>
        <h2>{title}</h2>
        {sub && <p>{sub}</p>}
      </div>
      {link && (
        <Link href={link}>
          Ayrıntı <ChevronRight size={16} />
        </Link>
      )}
    </div>
  );
}
function Health({ label, value }: { label: string; value: unknown }) {
  return (
    <div>
      <strong>{n(value)}</strong>
      <span>{label}</span>
    </div>
  );
}
function Trend({ rows }: { rows: Row[] }) {
  const max = Math.max(
    1,
    ...rows.flatMap((r) => [
      Number(r.new_organizations),
      Number(r.active_users),
    ]),
  );
  if (!rows.length)
    return (
      <Empty
        title="Henüz eğilim yok"
        detail="Yeni hareketler burada görünecek."
      />
    );
  return (
    <div className="pa-trend" role="img" aria-label="Günlük eğilim">
      {rows.map((r) => (
        <div key={String(r.day)} title={`${r.day}`}>
          <i
            style={{
              height: `${Math.max(3, (Number(r.active_users) / max) * 100)}%`,
            }}
          />
          <b
            style={{
              height: `${Math.max(3, (Number(r.new_organizations) / max) * 100)}%`,
            }}
          />
        </div>
      ))}
    </div>
  );
}

export function OrganizationsPage() {
  const router = useRouter(),
    p = useSearchParams(),
    q = p.toString();
  const { data, error, retry } = usePageLoad(
    `/api/v1/platform-admin/organizations?${q}`,
  );
  const update = (k: string, v: string) => {
    const x = new URLSearchParams(p);
    v ? x.set(k, v) : x.delete(k);
    x.delete("offset");
    router.replace(`/platform-admin/organizations?${x}`);
  };
  return (
    <>
      <PageHeader
        title="Firmalar"
        description="Aktivasyon, plan, deneme ve modül sağlığını tek dizinden yönetin."
        action={
          <Link
            className="pa-primary"
            href="/platform-admin/organizations?create=1"
          >
            Firma oluştur
          </Link>
        }
      />
      <div className="pa-toolbar">
        <label className="pa-search">
          <Search size={17} />
          <input
            aria-label="Firma ara"
            defaultValue={p.get("search") ?? ""}
            placeholder="Firma veya slug ara"
            onKeyDown={(e) =>
              e.key === "Enter" && update("search", e.currentTarget.value)
            }
          />
        </label>
        <select
          aria-label="Durum"
          value={p.get("status") ?? ""}
          onChange={(e) => update("status", e.target.value)}
        >
          <option value="">Tüm durumlar</option>
          <option value="pending_review">Onay bekleyen</option>
          <option value="active">Aktif</option>
          <option value="disabled">Devre dışı</option>
          <option value="rejected">Reddedildi</option>
        </select>
        <select
          aria-label="Sağlık"
          value={p.get("health") ?? ""}
          onChange={(e) => update("health", e.target.value)}
        >
          <option value="">Tüm sağlık durumları</option>
          <option value="healthy">Sağlıklı</option>
          <option value="attention">İzlenmeli</option>
          <option value="critical">Kritik</option>
        </select>
        <input
          aria-label="Başlangıç tarihi"
          type="date"
          value={p.get("createdFrom") ?? ""}
          onChange={(e) => update("createdFrom", e.target.value)}
        />
      </div>
      {!data && !error ? (
        <AdminSkeleton />
      ) : error ? (
        <ErrorState message={error} retry={retry} />
      ) : (
        <OrganizationTable response={data!} />
      )}{" "}
      {p.get("create") === "1" && (
        <CreateOrganization
          close={() => router.replace("/platform-admin/organizations")}
        />
      )}
    </>
  );
}
function OrganizationTable({ response }: { response: PageResponse }) {
  if (!response.data.length)
    return (
      <Empty
        title="Firma bulunamadı"
        detail="Filtreleri değiştirin veya yeni bir firma oluşturun."
      />
    );
  return (
    <div className="pa-table-wrap">
      <table>
        <caption className="sr-only">Platform firmaları</caption>
        <thead>
          <tr>
            <th>Firma</th>
            <th>Durum</th>
            <th>Plan</th>
            <th>Deneme</th>
            <th>Sağlık</th>
            <th>Üye</th>
            <th>Son aktivite</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {response.data.map((r) => (
            <tr key={String(r.id)}>
              <td>
                <strong>{String(r.name)}</strong>
                <small>{String(r.slug)}</small>
              </td>
              <td>
                <Status value={r.operational_status} />
              </td>
              <td>{String(r.plan_name ?? "—")}</td>
              <td>{dt(r.trial_ends_at)}</td>
              <td>
                <Status value={r.health_status} />
              </td>
              <td>{n(r.member_count)}</td>
              <td>{dt(r.last_activity_at)}</td>
              <td>
                <Link
                  className="pa-row-link"
                  href={`/platform-admin/organizations/${r.id}`}
                >
                  <ChevronRight size={18} />
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="pa-table-count">Toplam {n(response.page.total)} firma</p>
    </div>
  );
}
function CreateOrganization({ close }: { close: () => void }) {
  const router = useRouter();
  const [plans, setPlans] = useState<Row[]>([]),
    [error, setError] = useState("");
  useEffect(() => {
    void apiJson<{ data: Row[] }>("/api/v1/platform-admin/plans").then((r) =>
      setPlans(r.data),
    );
  }, []);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      const r = await apiJson<{ data: { organizationId: string } }>(
        "/api/v1/platform-admin/organizations",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: f.get("name"),
            slug: f.get("slug"),
            planCode: f.get("planCode"),
            ownerEmail: f.get("ownerEmail") || undefined,
            activateNow: f.get("activateNow") === "on",
            trialDays: 14,
          }),
        },
      );
      router.push(`/platform-admin/organizations/${r.data.organizationId}`);
    } catch (x) {
      setError((x as Error).message);
    }
  };
  return (
    <div className="pa-modal">
      <form className="pa-dialog" onSubmit={(e) => void submit(e)}>
        <div className="pa-dialog-head">
          <div>
            <h2>Firma oluştur</h2>
            <p>Doğrudan etkinleştirin veya inceleme kuyruğuna alın.</p>
          </div>
          <button type="button" onClick={close}>
            <X />
          </button>
        </div>
        <label>
          Firma adı
          <input name="name" required />
        </label>
        <label>
          Slug
          <input name="slug" pattern="[a-z0-9]+(?:-[a-z0-9]+)*" required />
        </label>
        <label>
          Firma sahibi e-postası
          <input name="ownerEmail" type="email" />
        </label>
        <label>
          Plan
          <select name="planCode">
            {plans.map((x) => (
              <option key={String(x.id)} value={String(x.code)}>
                {String(x.display_name)}
              </option>
            ))}
          </select>
        </label>
        <label className="pa-check">
          <input name="activateNow" type="checkbox" defaultChecked />
          <span>Şimdi etkinleştir ve 14 günlük denemeyi başlat</span>
        </label>
        {error && <p className="pa-form-error">{error}</p>}
        <div className="pa-dialog-actions">
          <button type="button" onClick={close}>
            Vazgeç
          </button>
          <button className="pa-primary">Firmayı oluştur</button>
        </div>
      </form>
    </div>
  );
}

export function UsersPage() {
  const p = useSearchParams(),
    router = useRouter();
  const { data, error, retry } = usePageLoad(
    `/api/v1/platform-admin/users?${p}`,
  );
  const [statusTarget, setStatusTarget] = useState<Row | null>(null);
  const [notice, setNotice] = useState("");
  const [actionError, setActionError] = useState("");
  const update = (k: string, v: string) => {
    const x = new URLSearchParams(p);
    v ? x.set(k, v) : x.delete(k);
    router.replace(`/platform-admin/users?${x}`);
  };
  const changeStatus = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!statusTarget) return;
    const next = statusTarget.status === "suspended" ? "active" : "suspended";
    const reason = String(new FormData(e.currentTarget).get("reason") ?? "");
    try {
      await apiJson(`/api/v1/platform-admin/users/${statusTarget.id}/status`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: next, reason: reason || undefined }),
      });
      setStatusTarget(null);
      setActionError("");
      retry();
    } catch (x) {
      setActionError((x as Error).message);
    }
  };
  const reset = async (r: Row) => {
    const x = await apiJson<{
      data: { delivered: boolean; resetUrl?: string };
    }>(`/api/v1/platform-admin/users/${r.id}/reset-password`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    setNotice(
      x.data.delivered
        ? "Sıfırlama bağlantısı e-posta ile gönderildi."
        : `Tek kullanımlık bağlantı: ${x.data.resetUrl}`,
    );
  };
  return (
    <>
      <PageHeader
        title="Kullanıcı dizini"
        description="Hesap durumu, doğrulama, son giriş ve firma üyelikleri."
      />
      <div className="pa-toolbar">
        <label className="pa-search">
          <Search size={17} />
          <input
            defaultValue={p.get("search") ?? ""}
            placeholder="E-posta veya ad ara"
            onKeyDown={(e) =>
              e.key === "Enter" && update("search", e.currentTarget.value)
            }
          />
        </label>
        <select
          value={p.get("status") ?? ""}
          onChange={(e) => update("status", e.target.value)}
        >
          <option value="">Tüm hesaplar</option>
          <option value="active">Aktif</option>
          <option value="suspended">Askıda</option>
          <option value="unverified">Doğrulanmamış</option>
        </select>
      </div>
      {!data && !error ? (
        <AdminSkeleton />
      ) : error ? (
        <ErrorState message={error} retry={retry} />
      ) : !data!.data.length ? (
        <Empty title="Kullanıcı bulunamadı" detail="Filtreleri değiştirin." />
      ) : (
        <div className="pa-table-wrap">
          <table>
            <thead>
              <tr>
                <th>Kullanıcı</th>
                <th>Durum</th>
                <th>Son giriş</th>
                <th>Üyelikler</th>
                <th>İşlemler</th>
              </tr>
            </thead>
            <tbody>
              {data!.data.map((r) => (
                <tr key={String(r.id)}>
                  <td>
                    <strong>{String(r.full_name)}</strong>
                    <small>{String(r.email)}</small>
                  </td>
                  <td>
                    <Status value={r.status} />
                  </td>
                  <td>{dt(r.last_login_at)}</td>
                  <td>
                    {(r.memberships as Row[])
                      .map((m) => `${m.organizationName} · ${m.role}`)
                      .join(", ") || "—"}
                  </td>
                  <td className="pa-actions">
                    <button onClick={() => void reset(r)}>
                      Sıfırlama bağlantısı
                    </button>
                    <button onClick={() => setStatusTarget(r)}>
                      {r.status === "suspended" ? "Etkinleştir" : "Askıya al"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {statusTarget && (
        <div className="pa-modal">
          <form className="pa-dialog" onSubmit={(e) => void changeStatus(e)}>
            <div className="pa-dialog-head">
              <div>
                <h2>
                  {statusTarget.status === "suspended"
                    ? "Kullanıcıyı etkinleştir"
                    : "Kullanıcıyı askıya al"}
                </h2>
                <p>{String(statusTarget.email)}</p>
              </div>
              <button type="button" onClick={() => setStatusTarget(null)}>
                <X />
              </button>
            </div>
            {statusTarget.status !== "suspended" && (
              <label>
                Gerekçe
                <textarea
                  name="reason"
                  minLength={3}
                  maxLength={500}
                  required
                />
              </label>
            )}
            <p>
              Askıya alma işlemi kullanıcının açık oturumlarını sonlandırır ve
              denetim geçmişine kaydedilir.
            </p>
            {actionError && <p className="pa-form-error">{actionError}</p>}
            <div className="pa-dialog-actions">
              <button type="button" onClick={() => setStatusTarget(null)}>
                Vazgeç
              </button>
              <button
                className={
                  statusTarget.status === "suspended"
                    ? "pa-primary"
                    : "danger pa-primary"
                }
              >
                İşlemi uygula
              </button>
            </div>
          </form>
        </div>
      )}
      {notice && (
        <div className="pa-modal">
          <section className="pa-dialog" role="dialog" aria-modal="true">
            <div className="pa-dialog-head">
              <div>
                <h2>Parola sıfırlama</h2>
                <p>Bağlantı sürelidir ve tek kullanımlıktır.</p>
              </div>
              <button type="button" onClick={() => setNotice("")}>
                <X />
              </button>
            </div>
            <p className="pa-reset-link">{notice}</p>
            <div className="pa-dialog-actions">
              <button className="pa-primary" onClick={() => setNotice("")}>
                Kapat
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}

export function OperationsPage() {
  const { data, error, retry } = useLoad<Row>(
    "/api/v1/platform-admin/operations",
  );
  return (
    <>
      <PageHeader
        title="Operasyon sağlığı"
        description="Kuyruklar, worker heartbeat ve dış bağlantıların güvenli durum bilgileri."
        action={
          <button onClick={retry}>
            <RefreshCw size={16} /> Yenile
          </button>
        }
      />
      {!data && !error ? (
        <AdminSkeleton />
      ) : error ? (
        <ErrorState message={error} retry={retry} />
      ) : (
        <div className="pa-grid-2">
          <DataPanel
            title="İş kuyrukları"
            rows={data!.queues as Row[]}
            columns={["queue", "active", "retry", "failed", "oldest_active_at"]}
          />
          <DataPanel
            title="Worker durumları"
            rows={data!.workers as Row[]}
            columns={[
              "service",
              "instance_id",
              "status",
              "current_jobs",
              "last_heartbeat",
            ]}
          />
          <DataPanel
            title="Entegrasyonlar"
            rows={data!.integrations as Row[]}
            columns={["provider", "status", "count", "last_health_at"]}
          />
        </div>
      )}
    </>
  );
}

export function AlertsPage() {
  const p = useSearchParams(),
    router = useRouter();
  const { data, error, retry } = usePageLoad(
    `/api/v1/platform-admin/alerts?${p}`,
  );
  const update = (k: string, v: string) => {
    const x = new URLSearchParams(p);
    v ? x.set(k, v) : x.delete(k);
    router.replace(`/platform-admin/alerts?${x}`);
  };
  const ack = async (id: unknown) => {
    await apiJson(`/api/v1/platform-admin/alerts/${id}/acknowledge`, {
      method: "PATCH",
    });
    retry();
  };
  return (
    <>
      <PageHeader
        title="Uyarı merkezi"
        description="Kalıcı, tekilleştirilmiş ve güvenli operasyon uyarıları."
      />
      <div className="pa-toolbar">
        <select
          value={p.get("status") ?? ""}
          onChange={(e) => update("status", e.target.value)}
        >
          <option value="">Tüm durumlar</option>
          <option value="open">Açık</option>
          <option value="acknowledged">Onaylandı</option>
          <option value="resolved">Çözüldü</option>
        </select>
        <select
          value={p.get("severity") ?? ""}
          onChange={(e) => update("severity", e.target.value)}
        >
          <option value="">Tüm önemler</option>
          <option value="critical">Kritik</option>
          <option value="warning">Uyarı</option>
          <option value="info">Bilgi</option>
        </select>
      </div>
      {!data && !error ? (
        <AdminSkeleton />
      ) : error ? (
        <ErrorState message={error} retry={retry} />
      ) : !data!.data.length ? (
        <Empty
          title="Uyarı yok"
          detail="Seçili filtrelerde aktif bir sinyal bulunmuyor."
        />
      ) : (
        <div className="pa-alert-list">
          {data!.data.map((a) => (
            <article key={String(a.id)} className={`pa-alert ${a.severity}`}>
              <AlertTriangle />
              <div>
                <div className="pa-alert-title">
                  <strong>{String(a.title)}</strong>
                  <Status value={a.status} />
                </div>
                <p>{String(a.message)}</p>
                <small>
                  {a.organization_name ? `${a.organization_name} · ` : ""}Son
                  görülme {dt(a.last_seen_at)}
                </small>
              </div>
              {a.status === "open" && (
                <button onClick={() => void ack(a.id)}>Görüldü</button>
              )}
            </article>
          ))}
        </div>
      )}
    </>
  );
}

export function AuditPage() {
  const p = useSearchParams(),
    router = useRouter();
  const { data, error, retry } = usePageLoad(
    `/api/v1/platform-admin/audit-log?${p}`,
  );
  const update = (k: string, v: string) => {
    const x = new URLSearchParams(p);
    v ? x.set(k, v) : x.delete(k);
    router.replace(`/platform-admin/audit?${x}`);
  };
  const csv = async () => {
    const r = await apiFetch(`/api/v1/platform-admin/audit-log/export?${p}`);
    const b = await r.blob(),
      a = document.createElement("a");
    a.href = URL.createObjectURL(b);
    a.download = "brixchat24-denetim.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  };
  return (
    <>
      <PageHeader
        title="Denetim geçmişi"
        description="Aktör, hedef, gerekçe ve değişiklik kayıtları."
        action={<button onClick={() => void csv()}>CSV dışa aktar</button>}
      />
      <div className="pa-toolbar">
        <input
          type="date"
          value={p.get("createdFrom") ?? ""}
          onChange={(e) => update("createdFrom", e.target.value)}
        />
        <select
          value={p.get("severity") ?? ""}
          onChange={(e) => update("severity", e.target.value)}
        >
          <option value="">Tüm önemler</option>
          <option value="info">Bilgi</option>
          <option value="warning">Uyarı</option>
          <option value="critical">Kritik</option>
        </select>
      </div>
      {!data && !error ? (
        <AdminSkeleton />
      ) : error ? (
        <ErrorState message={error} retry={retry} />
      ) : !data!.data.length ? (
        <Empty
          title="Denetim kaydı yok"
          detail="Yönetim işlemleri burada izlenir."
        />
      ) : (
        <div className="pa-table-wrap">
          <table>
            <thead>
              <tr>
                <th>Zaman</th>
                <th>İşlem</th>
                <th>Firma</th>
                <th>Aktör</th>
                <th>Önem</th>
              </tr>
            </thead>
            <tbody>
              {data!.data.map((r) => (
                <tr key={String(r.id)}>
                  <td>{dt(r.created_at)}</td>
                  <td>
                    <strong>{String(r.action)}</strong>
                  </td>
                  <td>{String(r.organization_name ?? "—")}</td>
                  <td>{String(r.actor_email ?? r.actor ?? "Sistem")}</td>
                  <td>
                    <Status value={r.severity ?? "info"} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

export function BillingPage() {
  const prices = useLoad<Row[]>("/api/v1/platform-admin/billing/prices");
  const overview = useLoad<Row>("/api/v1/platform-admin/billing/overview");
  const [tab, setTab] = useState("catalog");
  const error = prices.error || overview.error;
  const retry = () => {
    prices.retry();
    overview.retry();
  };
  const summary = (overview.data?.summary ?? {}) as Row;
  const tabs = [
    ["catalog", "Katalog"],
    ["subscriptions", "Firma abonelikleri"],
    ["transactions", "İşlemler"],
    ["requests", "Hat satış talepleri"],
  ] as const;
  return (
    <>
      <PageHeader
        title="Abonelik ve fiyatlar"
        description="Katalog, firma abonelikleri, finansal işlemler ve ek hat taleplerini izleyin."
      />
      {!prices.data && !overview.data && !error ? (
        <AdminSkeleton />
      ) : error ? (
        <ErrorState message={error} retry={retry} />
      ) : (
        <>
          <section className="pa-kpi-grid">
            {[
              ["Etkin abonelik", summary.active_subscriptions ?? 0, "good"],
              ["Ödeme takibi", summary.payment_attention ?? 0, "critical"],
              ["Son 30 gün işlem", summary.transactions_30d ?? 0, ""],
              [
                "Bekleyen hat talebi",
                summary.pending_sales_requests ?? 0,
                "warning",
              ],
            ].map(([label, value, tone]) => (
              <article key={String(label)} className={`pa-kpi ${tone}`}>
                <span>{String(label)}</span>
                <strong>{String(value)}</strong>
              </article>
            ))}
          </section>
          <nav className="pa-tabs" aria-label="Abonelik bölümleri">
            {tabs.map(([key, label]) => (
              <button
                key={key}
                className={tab === key ? "active" : ""}
                aria-current={tab === key ? "page" : undefined}
                onClick={() => setTab(key)}
              >
                {label}
              </button>
            ))}
          </nav>
          {tab === "catalog" && (
            <DataPanel
              title="Fiyat kataloğu"
              rows={prices.data ?? []}
              columns={[
                "product_code",
                "currency",
                "interval",
                "unit_amount_minor",
                "tax_mode",
                "active",
              ]}
            />
          )}
          {tab === "subscriptions" && (
            <DataPanel
              title="Firma abonelikleri"
              rows={(overview.data?.subscriptions ?? []) as Row[]}
              columns={[
                "organization_name",
                "plan_code",
                "provider",
                "status",
                "current_period_end",
                "grace_ends_at",
              ]}
            />
          )}
          {tab === "transactions" && (
            <DataPanel
              title="Finansal işlemler"
              rows={(overview.data?.transactions ?? []) as Row[]}
              columns={[
                "organization_name",
                "provider",
                "status",
                "currency",
                "subtotal_minor",
                "tax_minor",
                "total_minor",
                "billed_at",
              ]}
            />
          )}
          {tab === "requests" && (
            <DataPanel
              title="Hat satış talepleri"
              rows={(overview.data?.salesRequests ?? []) as Row[]}
              columns={[
                "organization_name",
                "product_name",
                "quantity",
                "status",
                "created_at",
                "reviewed_at",
              ]}
            />
          )}
        </>
      )}
    </>
  );
}

export function SettingsPage() {
  const { data, error, retry } = useLoad<Row[]>(
    "/api/v1/platform-admin/admins",
  );
  return (
    <>
      <PageHeader
        title="Platform ayarları"
        description="Platform sahibi erişimi ve dış servis yapılandırma durumu."
      />
      <div className="pa-grid-2">
        <section className="pa-panel">
          <PanelHead
            title="Platform sahibi"
            sub="Bu sürümde yönetim merkezi yalnızca platform sahibi hesabına açıktır."
          />
          {error ? (
            <ErrorState message={error} retry={retry} />
          ) : (
            <ul className="pa-admin-list">
              {data?.map((r) => (
                <li key={String(r.id)}>
                  <div>
                    <strong>{String(r.full_name)}</strong>
                    <span>{String(r.email)}</span>
                  </div>
                  <Status value="active" />
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="pa-panel">
          <PanelHead
            title="İsteğe bağlı bağlantılar"
            sub="Eksikleri uygulamanın açılmasını engellemez."
          />
          <ul className="pa-signal-list">
            <li>
              <span>SMTP</span>
              <small>Ortam ayarlarından yönetilir</small>
            </li>
            <li>
              <span>Meta / WhatsApp</span>
              <small>Firma arayüzünden bağlanır</small>
            </li>
            <li>
              <span>Bitrix24</span>
              <small>Firma arayüzünden bağlanır</small>
            </li>
            <li>
              <span>AI ve depolama</span>
              <small>Firma arayüzünden bağlanır</small>
            </li>
          </ul>
        </section>
      </div>
    </>
  );
}

export function DataPanel({
  title,
  rows,
  columns,
}: {
  title: string;
  rows: Row[];
  columns: string[];
}) {
  return (
    <section className="pa-panel pa-data-panel">
      <PanelHead title={title} />
      {!rows.length ? (
        <Empty title="Kayıt yok" detail="Bu bölümde henüz veri oluşmadı." />
      ) : (
        <div className="pa-table-wrap compact">
          <table>
            <thead>
              <tr>
                {columns.map((c) => (
                  <th key={c}>{c.replaceAll("_", " ")}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={String(r.id ?? r.instance_id ?? i)}>
                  {columns.map((c) => (
                    <td key={c}>
                      {c.endsWith("_at")
                        ? dt(r[c])
                        : typeof r[c] === "boolean"
                          ? r[c]
                            ? "Evet"
                            : "Hayır"
                          : String(r[c] ?? "—")}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function OrganizationDetailPage({ id }: { id: string }) {
  const p = useSearchParams(),
    router = useRouter(),
    tab = p.get("tab") ?? "overview";
  const { data, error, retry } = useLoad<Row>(
    `/api/v1/platform-admin/organizations/${id}`,
  );
  const ops = useLoad<Row>(
    `/api/v1/platform-admin/organizations/${id}/operations`,
  );
  const members = useLoad<Row[]>(
    `/api/v1/platform-admin/organizations/${id}/members`,
  );
  const [action, setAction] = useState<
    "approve" | "reject" | "disable" | "enable" | null
  >(null);
  const go = (x: string) =>
    router.replace(`/platform-admin/organizations/${id}?tab=${x}`);
  if (!data && !error) return <AdminSkeleton />;
  if (error) return <ErrorState message={error} retry={retry} />;
  const org = data!.organization as Row;
  const tabs = [
    ["overview", "Genel Bakış"],
    ["members", "Üyeler"],
    ["subscription", "Abonelik"],
    ["modules", "Modüller"],
    ["usage", "Kullanım"],
    ["alerts", "Uyarılar"],
    ["history", "Geçmiş"],
  ];
  return (
    <>
      <PageHeader
        title={String(org.name)}
        description={`${org.slug} · güvenli firma operasyon görünümü`}
        action={
          <div className="pa-actions">
            {org.operational_status !== "active" && (
              <button
                className="pa-primary"
                onClick={() => setAction("approve")}
              >
                Onayla
              </button>
            )}
            {org.operational_status === "pending_review" && (
              <button onClick={() => setAction("reject")}>Reddet</button>
            )}
            {org.operational_status === "active" ? (
              <button className="danger" onClick={() => setAction("disable")}>
                Devre dışı bırak
              </button>
            ) : (
              org.operational_status === "disabled" && (
                <button onClick={() => setAction("enable")}>Etkinleştir</button>
              )
            )}
          </div>
        }
      />
      <nav className="pa-tabs" aria-label="Firma ayrıntıları">
        {tabs.map(([key, label]) => (
          <button
            key={key}
            className={tab === key ? "active" : ""}
            onClick={() => go(String(key))}
          >
            {label}
          </button>
        ))}
      </nav>
      <section className="pa-detail-body">
        {tab === "overview" && (
          <Overview org={org} owner={data!.owner as Row} />
        )}{" "}
        {tab === "members" && (
          <Members rows={members.data ?? []} retry={members.retry} />
        )}{" "}
        {tab === "subscription" && <Subscription org={org} />}{" "}
        {tab === "modules" && <Modules data={ops.data} />}{" "}
        {tab === "usage" && (
          <DataPanel
            title="Son 30 gün kullanımı"
            rows={(ops.data?.usage as Row[]) ?? []}
            columns={["usage_date", "metric", "quantity"]}
          />
        )}{" "}
        {tab === "alerts" && <OrganizationAlerts id={id} />}{" "}
        {tab === "history" && (
          <DataPanel
            title="Durum geçmişi"
            rows={(data!.audit as Row[]) ?? []}
            columns={[
              "created_at",
              "action",
              "actor_email",
              "reason",
              "severity",
            ]}
          />
        )}
      </section>
      {action && (
        <OrganizationAction
          id={id}
          action={action}
          close={() => setAction(null)}
          done={() => {
            setAction(null);
            retry();
          }}
        />
      )}
    </>
  );
}
function Overview({ org, owner }: { org: Row; owner: Row }) {
  return (
    <div className="pa-grid-2">
      <section className="pa-panel">
        <PanelHead title="Firma durumu" />
        <dl className="pa-definition">
          <div>
            <dt>Durum</dt>
            <dd>
              <Status value={org.operational_status} />
            </dd>
          </div>
          <div>
            <dt>Aktivasyon</dt>
            <dd>{String(org.activation_status)}</dd>
          </div>
          <div>
            <dt>Talep zamanı</dt>
            <dd>{dt(org.activation_requested_at)}</dd>
          </div>
          <div>
            <dt>Onay zamanı</dt>
            <dd>{dt(org.activated_at)}</dd>
          </div>
          <div>
            <dt>Gerekçe</dt>
            <dd>{String(org.status_reason ?? "—")}</dd>
          </div>
        </dl>
      </section>
      <section className="pa-panel">
        <PanelHead title="Hesap özeti" />
        <dl className="pa-definition">
          <div>
            <dt>Firma sahibi</dt>
            <dd>{String(owner?.email ?? "—")}</dd>
          </div>
          <div>
            <dt>Plan</dt>
            <dd>{String(org.plan_name ?? "—")}</dd>
          </div>
          <div>
            <dt>Deneme durumu</dt>
            <dd>{String(org.trial_status ?? "—")}</dd>
          </div>
          <div>
            <dt>Deneme bitişi</dt>
            <dd>{dt(org.trial_ends_at)}</dd>
          </div>
          <div>
            <dt>Oluşturulma</dt>
            <dd>{dt(org.created_at)}</dd>
          </div>
        </dl>
      </section>
    </div>
  );
}
function Members({ rows, retry }: { rows: Row[]; retry: () => void }) {
  const reset = async (r: Row) => {
    const x = await apiJson<{
      data: { delivered: boolean; resetUrl?: string };
    }>(`/api/v1/platform-admin/users/${r.id}/reset-password`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    alert(
      x.data.delivered
        ? "Bağlantı e-posta ile gönderildi."
        : `Bu bağlantı yalnızca şimdi gösterilir:\n${x.data.resetUrl}`,
    );
    retry();
  };
  return (
    <div className="pa-table-wrap">
      <table>
        <thead>
          <tr>
            <th>Kullanıcı</th>
            <th>Rol</th>
            <th>Katılım</th>
            <th>Güvenlik</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={String(r.id)}>
              <td>
                <strong>{String(r.full_name)}</strong>
                <small>{String(r.email)}</small>
              </td>
              <td>{String(r.role)}</td>
              <td>{dt(r.joined_at)}</td>
              <td>
                <button onClick={() => void reset(r)}>
                  Sıfırlama bağlantısı
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function Subscription({ org }: { org: Row }) {
  return (
    <div className="pa-grid-2">
      <section className="pa-panel">
        <PanelHead title="Geçerli abonelik" />
        <dl className="pa-definition">
          <div>
            <dt>Plan</dt>
            <dd>{String(org.plan_name ?? "—")}</dd>
          </div>
          <div>
            <dt>Deneme</dt>
            <dd>{String(org.trial_status ?? "—")}</dd>
          </div>
          <div>
            <dt>Bitiş</dt>
            <dd>{dt(org.trial_ends_at)}</dd>
          </div>
          <div>
            <dt>Grace period</dt>
            <dd>{dt(org.grace_ends_at)}</dd>
          </div>
        </dl>
        <p className="pa-footnote">
          Plan ve süre değişiklikleri açıklamalı işlem akışıyla, tek transaction
          ve denetim kaydıyla uygulanır.
        </p>
      </section>
    </div>
  );
}
function Modules({ data }: { data: Row | null }) {
  if (!data) return <AdminSkeleton />;
  return (
    <div className="pa-grid-2">
      <DataPanel
        title="Kanallar"
        rows={(data.channels as Row[]) ?? []}
        columns={[
          "provider",
          "connection_status",
          "health_state",
          "count",
          "last_health_at",
        ]}
      />
      <DataPanel
        title="Entegrasyonlar"
        rows={(data.integrations as Row[]) ?? []}
        columns={["provider", "status", "last_health_at", "last_error_code"]}
      />
      <DataPanel
        title="Kampanyalar"
        rows={[data.campaigns as Row]}
        columns={[
          "campaigns",
          "recipients",
          "failed_recipients",
          "last_campaign_at",
        ]}
      />
      <DataPanel
        title="Otomasyonlar"
        rows={(data.automations as Row[]) ?? []}
        columns={["status", "count", "last_run_at"]}
      />
      <DataPanel
        title="AI çalışmaları"
        rows={(data.ai as Row[]) ?? []}
        columns={["status", "count", "last_run_at", "cost_usd"]}
      />
      <DataPanel
        title="Kuyruklar"
        rows={(data.queues as Row[]) ?? []}
        columns={["queue", "active", "retry", "failed", "oldest_active_at"]}
      />
    </div>
  );
}
function OrganizationAlerts({ id }: { id: string }) {
  const { data, error, retry } = usePageLoad(
    `/api/v1/platform-admin/alerts?organizationId=${id}`,
  );
  if (!data && !error) return <AdminSkeleton />;
  if (error) return <ErrorState message={error} retry={retry} />;
  return !data!.data.length ? (
    <Empty
      title="Firma uyarısı yok"
      detail="Bu firmada açık veya geçmiş uyarı bulunmuyor."
    />
  ) : (
    <div className="pa-alert-list">
      {data!.data.map((a) => (
        <article className={`pa-alert ${a.severity}`} key={String(a.id)}>
          <AlertTriangle />
          <div>
            <strong>{String(a.title)}</strong>
            <p>{String(a.message)}</p>
            <small>{dt(a.last_seen_at)}</small>
          </div>
          <Status value={a.status} />
        </article>
      ))}
    </div>
  );
}
function OrganizationAction({
  id,
  action,
  close,
  done,
}: {
  id: string;
  action: "approve" | "reject" | "disable" | "enable";
  close: () => void;
  done: () => void;
}) {
  const [plans, setPlans] = useState<Row[]>([]),
    [error, setError] = useState("");
  useEffect(() => {
    if (action === "approve")
      void apiJson<{ data: Row[] }>("/api/v1/platform-admin/plans").then((r) =>
        setPlans(r.data),
      );
  }, [action]);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget),
      reason = String(f.get("reason") ?? "");
    try {
      if (action === "approve")
        await apiJson(`/api/v1/platform-admin/organizations/${id}/approve`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            planCode: f.get("planCode") || "trial",
            trialDays: Number(f.get("trialDays") || 14),
          }),
        });
      else if (action === "reject")
        await apiJson(`/api/v1/platform-admin/organizations/${id}/reject`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reason }),
        });
      else
        await apiJson(`/api/v1/platform-admin/organizations/${id}/status`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            disabled: action === "disable",
            reason: reason || undefined,
          }),
        });
      done();
    } catch (x) {
      setError((x as Error).message);
    }
  };
  const title = {
    approve: "Firmayı onayla",
    reject: "Başvuruyu reddet",
    disable: "Firmayı devre dışı bırak",
    enable: "Firmayı etkinleştir",
  }[action];
  return (
    <div className="pa-modal">
      <form className="pa-dialog" onSubmit={(e) => void submit(e)}>
        <div className="pa-dialog-head">
          <div>
            <h2>{title}</h2>
            <p>Bu işlem güvenlik ve denetim geçmişine kaydedilir.</p>
          </div>
          <button type="button" onClick={close}>
            <X />
          </button>
        </div>
        {action === "approve" ? (
          <>
            <label>
              Plan
              <select name="planCode">
                {plans.map((x) => (
                  <option key={String(x.id)} value={String(x.code)}>
                    {String(x.display_name)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Deneme süresi (gün)
              <input
                name="trialDays"
                type="number"
                defaultValue="14"
                min="0"
                max="365"
              />
            </label>
          </>
        ) : (
          action !== "enable" && (
            <label>
              Gerekçe
              <textarea name="reason" minLength={3} maxLength={500} required />
            </label>
          )
        )}
        {error && <p className="pa-form-error">{error}</p>}
        <div className="pa-dialog-actions">
          <button type="button" onClick={close}>
            Vazgeç
          </button>
          <button
            className={
              action === "reject" || action === "disable"
                ? "danger pa-primary"
                : "pa-primary"
            }
          >
            İşlemi uygula
          </button>
        </div>
      </form>
    </div>
  );
}
