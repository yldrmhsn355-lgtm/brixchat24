"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const AI_NAV_ITEMS: ReadonlyArray<{ href: string; label: string }> = [
  { href: "/app/ai-chats", label: "Ajanlar" },
  { href: "/app/ai-chats/knowledge", label: "Bilgi Tabanı" },
  { href: "/app/ai-chats/training", label: "Eğitim" },
  { href: "/app/ai-chats/playground", label: "Playground" },
  { href: "/app/ai-chats/evaluations", label: "Değerlendirme" },
  { href: "/app/ai-chats/runs", label: "Çalışmalar" },
  { href: "/app/ai-chats/usage", label: "Kullanım" },
  { href: "/app/ai-chats/settings", label: "Ayarlar" },
];

export function AiNav() {
  const pathname = usePathname();

  function isActive(href: string) {
    if (href === "/app/ai-chats") {
      return (
        pathname === href || pathname.startsWith("/app/ai-chats/agents")
      );
    }
    return pathname === href || pathname.startsWith(`${href}/`);
  }

  return (
    <nav className="settings-tabs ai-nav" aria-label="AI modülü bölümleri">
      {AI_NAV_ITEMS.map((item) => {
        const active = isActive(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={active ? "active" : undefined}
            aria-current={active ? "page" : undefined}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
