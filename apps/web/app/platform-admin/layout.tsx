import type { ReactNode } from "react";
import { PlatformAdminShell } from "./_components/platform-admin";
import "./platform-admin.css";

export default function PlatformAdminLayout({
  children,
}: {
  children: ReactNode;
}) {
  return <PlatformAdminShell>{children}</PlatformAdminShell>;
}
