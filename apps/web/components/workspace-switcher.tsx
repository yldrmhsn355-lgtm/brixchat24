"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { apiJson, setAccessToken } from "../lib/api";

type Workspace = {
  id: string;
  name: string;
  slug: string;
  role: string;
  active: boolean;
};

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toLocaleUpperCase("tr") ?? "")
    .join("");
}

export function WorkspaceSwitcher() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [open, setOpen] = useState(false);
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    void apiJson<{ data: Workspace[] }>("/api/v1/auth/workspaces")
      .then((result) => setWorkspaces(result.data))
      .catch((reason: unknown) =>
        setError(
          reason instanceof Error
            ? reason.message
            : "Çalışma alanları yüklenemedi.",
        ),
      );
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const active =
    workspaces.find((workspace) => workspace.active) ?? workspaces[0];
  const name = active?.name ?? "Çalışma alanı";

  async function switchWorkspace(workspace: Workspace) {
    if (workspace.active || switchingId) {
      setOpen(false);
      return;
    }
    setSwitchingId(workspace.id);
    setError("");
    try {
      const result = await apiJson<{ data: { accessToken: string } }>(
        "/api/v1/auth/switch-workspace",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ organizationId: workspace.id }),
        },
      );
      setAccessToken(result.data.accessToken);
      localStorage.removeItem("selected_whatsapp_channel_id");
      localStorage.removeItem("brixchat_inbox_drafts_v1");
      window.location.assign("/app/inbox");
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Workspace değiştirilemedi.",
      );
      setSwitchingId(null);
    }
  }

  if (workspaces.length <= 1) {
    return (
      <div className="workspace-switch workspace-switch-static">
        <span className="workspace-logo">{initials(name) || "W"}</span>
        <span>
          <strong>{name}</strong>
          <small>{active?.role ?? (error ? "Yüklenemedi" : "Workspace")}</small>
        </span>
      </div>
    );
  }

  return (
    <div className="workspace-switcher" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="workspace-switch"
        aria-label={`Workspace değiştir, mevcut: ${name}`}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((current) => !current)}
      >
        <span className="workspace-logo">{initials(name) || "W"}</span>
        <span>
          <strong>{name}</strong>
          <small>{active?.role}</small>
        </span>
        <ChevronDown size={15} aria-hidden="true" />
      </button>
      {open && (
        <div className="workspace-menu" role="menu" aria-label="Workspaceler">
          {workspaces.map((workspace) => (
            <button
              type="button"
              role="menuitemradio"
              aria-checked={workspace.active}
              disabled={Boolean(switchingId)}
              key={workspace.id}
              onClick={() => void switchWorkspace(workspace)}
            >
              <span className="workspace-logo">
                {initials(workspace.name) || "W"}
              </span>
              <span>
                <strong>{workspace.name}</strong>
                <small>{workspace.role}</small>
              </span>
              {workspace.active && <Check size={16} aria-hidden="true" />}
            </button>
          ))}
        </div>
      )}
      {error && (
        <span
          className="workspace-switch-error"
          role="alert"
          aria-live="assertive"
        >
          {error}
        </span>
      )}
    </div>
  );
}
