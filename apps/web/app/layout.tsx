import type { Metadata, Viewport } from "next";
import "./globals.css";
import "./realtime.css";
import "./design-system.css";
import "./professional-theme.css";
export const metadata: Metadata = {
  title: "Brixchat24 — Shared inbox for modern care teams",
  description:
    "A multi-tenant WhatsApp CRM and shared inbox for customer operations.",
};
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

const themeBootScript = `(() => {
  try {
    const saved = localStorage.getItem("brixchat_app_theme");
    const theme = saved === "light" || saved === "dark"
      ? saved
      : (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    document.documentElement.dataset.appTheme = theme;
    document.documentElement.style.colorScheme = theme;
  } catch (_) {
    document.documentElement.dataset.appTheme = "dark";
    document.documentElement.style.colorScheme = "dark";
  }
})();`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="tr" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
