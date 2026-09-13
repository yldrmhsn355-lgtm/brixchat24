"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Bot,
  BookOpenText,
  CreditCard,
  FolderOpen,
  HelpCircle,
  Inbox,
  LogOut,
  Menu,
  Megaphone,
  MessageCircleMore,
  MessagesSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Plug,
  Radio,
  Settings,
  ShieldCheck,
  Sparkles,
  Tag,
  Users,
  X,
  Zap,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Button } from "@brixchat/ui";
import { apiJson, logout } from "../lib/api";
import { useViewportMetrics } from "../hooks/use-viewport-metrics";
import { GlobalSearch } from "./global-search";
import { NotificationCenter } from "./notification-center";
import { WorkspaceSwitcher } from "./workspace-switcher";
import { ThemeToggle } from "./theme-toggle";

type NavigationItem = {
  href: string;
  label: string;
  icon: LucideIcon;
};

const navigationGroups: ReadonlyArray<{
  label: string;
  items: ReadonlyArray<NavigationItem>;
}> = [
  {
    label: "Çalışma alanı",
    items: [
      { href: "/app/inbox", label: "Gelen Kutusu", icon: Inbox },
      { href: "/app/ai-chats", label: "AI Chats", icon: Bot },
      { href: "/app/files", label: "Dosyalar ve Belgeler", icon: FolderOpen },
      { href: "/app/templates", label: "Şablonlar", icon: BookOpenText },
      { href: "/app/campaigns", label: "Kampanyalar", icon: Megaphone },
      {
        href: "/app/quick-replies",
        label: "Hazır Cevaplar",
        icon: MessagesSquare,
      },
      { href: "/app/labels", label: "Etiketler", icon: Tag },
    ],
  },
  {
    label: "Yönetim",
    items: [
      { href: "/app/channels", label: "Kanallar", icon: Radio },
      { href: "/app/integrations", label: "Entegrasyonlar", icon: Plug },
      { href: "/app/automations", label: "Otomasyonlar", icon: Zap },
      { href: "/app/team", label: "Ekip", icon: Users },
      { href: "/app/billing", label: "Abonelik", icon: CreditCard },
      { href: "/app/settings/profile", label: "Ayarlar", icon: Settings },
    ],
  },
];

export const appNavigation = navigationGroups.flatMap((group) => group.items);

function isActiveRoute(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

function Navigation({
  onNavigate,
  ariaLabel = "Ana menü",
}: {
  onNavigate?: () => void;
  ariaLabel?: string;
}) {
  const pathname = usePathname();
  return (
    <nav className="sidebar-nav" aria-label={ariaLabel}>
      {navigationGroups.map((group) => (
        <div className="nav-group" key={group.label}>
          <span className="nav-group-label">{group.label}</span>
          {group.items.map((item) => {
            const active = isActiveRoute(pathname, item.href);
            return (
              <Link
                className={active ? "nav-item active" : "nav-item"}
                href={item.href}
                key={item.href}
                {...(onNavigate ? { onClick: onNavigate } : {})}
                aria-current={active ? "page" : undefined}
              >
                <span className="nav-icon-shell" aria-hidden="true">
                  <item.icon size={18} />
                </span>
                <span className="nav-item-text">{item.label}</span>
                <span className="nav-item-beam" aria-hidden="true" />
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

export function AppSidebar({
  showWorkspace = true,
}: {
  showWorkspace?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setCollapsed(
        localStorage.getItem("brixchat_sidebar_collapsed") === "true",
      );
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  function toggleCollapsed() {
    setCollapsed((current) => {
      const next = !current;
      localStorage.setItem("brixchat_sidebar_collapsed", String(next));
      return next;
    });
  }

  return (
    <aside
      className={`sidebar premium-sidebar${collapsed ? " is-collapsed" : ""}`}
    >
      <div className="sidebar-brand">
        <div className="brand-lockup compact">
          <span className="brand-mark" aria-hidden="true">
            <MessageCircleMore size={19} aria-hidden="true" />
          </span>
          <span className="brand-copy">
            <strong>Brixchat24</strong>
            <small>Akıllı iletişim merkezi</small>
          </span>
          <span className="brand-presence" aria-hidden="true" />
        </div>
        {showWorkspace && (
          <div className="sidebar-workspace">
            <WorkspaceSwitcher />
          </div>
        )}
      </div>
      <Navigation />
      <div className="sidebar-bottom">
        <div className="sidebar-secure-note">
          <span aria-hidden="true">
            <ShieldCheck size={15} />
          </span>
          <span>
            <strong>Güvenli çalışma alanı</strong>
            <small>Rol tabanlı erişim</small>
          </span>
        </div>
        <Link className="nav-item" href="/app/help">
          <span className="nav-icon-shell" aria-hidden="true">
            <HelpCircle size={18} />
          </span>
          <span className="nav-item-text">Yardım</span>
        </Link>
        <Button
          variant="ghost"
          size="sm"
          className="nav-item"
          onClick={() => void logout()}
        >
          <span className="nav-icon-shell" aria-hidden="true">
            <LogOut size={18} />
          </span>
          <span className="nav-item-text">Çıkış yap</span>
        </Button>
        <button
          type="button"
          className="sidebar-collapse-control"
          aria-label={
            collapsed ? "Kenar çubuğunu genişlet" : "Kenar çubuğunu daralt"
          }
          aria-pressed={collapsed}
          onClick={toggleCollapsed}
        >
          {collapsed ? (
            <PanelLeftOpen size={17} aria-hidden="true" />
          ) : (
            <PanelLeftClose size={17} aria-hidden="true" />
          )}
          <span>{collapsed ? "Genişlet" : "Daralt"}</span>
        </button>
      </div>
    </aside>
  );
}

export function MobileNavigation() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusable = () =>
      Array.from(
        drawerRef.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
    focusable()[0]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (!items.length) return;
      const first = items[0]!;
      const last = items.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
      trigger?.focus();
    };
  }, [open]);

  return (
    <>
      <Button
        ref={triggerRef}
        variant="ghost"
        size="icon"
        className="mobile-nav-trigger mobile-only"
        aria-label="Ana menüyü aç"
        aria-expanded={open}
        aria-controls="mobile-navigation-drawer"
        onClick={() => setOpen(true)}
      >
        <Menu size={21} aria-hidden="true" />
      </Button>
      {open && (
        <div className="mobile-nav-layer">
          <button
            type="button"
            className="mobile-nav-backdrop"
            aria-label="Ana menüyü kapat"
            onClick={() => setOpen(false)}
          />
          <div
            ref={drawerRef}
            id="mobile-navigation-drawer"
            className="mobile-nav-drawer"
            role="dialog"
            aria-modal="true"
            aria-labelledby="mobile-navigation-title"
          >
            <header>
              <div className="brand-lockup">
                <span className="brand-mark">
                  <MessageCircleMore size={19} aria-hidden="true" />
                </span>
                <span className="brand-copy">
                  <strong id="mobile-navigation-title">Brixchat24</strong>
                  <small>Akıllı iletişim merkezi</small>
                </span>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="icon-button"
                aria-label="Ana menüyü kapat"
                onClick={() => setOpen(false)}
              >
                <X size={20} aria-hidden="true" />
              </Button>
            </header>
            <Navigation
              ariaLabel="Mobil ana menü"
              onNavigate={() => setOpen(false)}
            />
            <Link
              className="nav-item"
              href="/app/help"
              onClick={() => setOpen(false)}
            >
              <HelpCircle size={19} aria-hidden="true" />
              <span>Yardım</span>
            </Link>
            <Button
              variant="ghost"
              size="sm"
              className="nav-item"
              onClick={() => void logout()}
            >
              <LogOut size={19} aria-hidden="true" />
              <span>Çıkış yap</span>
            </Button>
          </div>
        </div>
      )}
    </>
  );
}

export function AppFrame({
  title,
  subtitle,
  children,
  actions,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
}) {
  useViewportMetrics();
  const pathname = usePathname();
  const mainAreaRef = useRef<HTMLElement>(null);

  useEffect(() => {
    void apiJson<{ data: { organizationStatus?: string } }>("/api/v1/auth/me")
      .then(({ data }) => {
        if (data.organizationStatus === "pending_review")
          window.location.replace("/pending-approval");
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0 });
    mainAreaRef.current?.scrollTo({ top: 0, left: 0 });
  }, [pathname]);

  return (
    <div className="app-shell app-shell-premium">
      <a className="skip-link" href="#main-content">
        Ana içeriğe geç
      </a>
      <AppSidebar />
      <main
        id="main-content"
        ref={mainAreaRef}
        className="main-area"
        tabIndex={-1}
      >
        <header className="topbar premium-topbar">
          <MobileNavigation />
          <div className="page-title">
            <p className="eyebrow">Akıllı operasyon</p>
            <h1>{title}</h1>
          </div>
          <div className="topbar-actions">
            <span
              className="topbar-context"
              aria-label="Brixchat24 çalışma alanı"
            >
              <Sparkles size={14} aria-hidden="true" />
              Brixchat24
            </span>
            <GlobalSearch />
            <ThemeToggle />
            <NotificationCenter />
            {actions}
          </div>
        </header>
        <section className="management-page premium-management-page">
          {subtitle && <p className="page-subtitle">{subtitle}</p>}
          {children}
        </section>
      </main>
    </div>
  );
}
