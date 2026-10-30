"use client";

import { Check, ChevronDown } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { apiFetch } from "@/lib/api";
import { setWorkspaceId, type WorkspaceMembership } from "@/lib/workspaces";
import { workspaceMenuPortalTarget } from "@/lib/workspace-menu";

type MenuPosition = { position: "absolute" | "fixed"; left: number; bottom: number; maxHeight: number; width: number };

export function WorkspaceMenu({ children, resetKey, workspaces }: {
  children: ReactNode;
  resetKey: string;
  workspaces: WorkspaceMembership[];
}) {
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const [error, setError] = useState("");
  const [switching, setSwitching] = useState(false);
  const switchingRef = useRef(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const portalRef = useRef<HTMLElement | null>(null);
  const menuId = useId();
  const triggerId = useId();
  const current = workspaces.find((workspace) => workspace.isCurrent);

  const close = () => {
    setPosition(null);
    triggerRef.current?.focus();
  };

  useEffect(() => { setPosition(null); }, [resetKey]);

  useEffect(() => {
    if (!position) return;
    menuRef.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    const handlePointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || menuRef.current?.contains(event.target) || triggerRef.current?.contains(event.target)) return;
      setPosition(null);
    };
    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    const handleResize = () => close();
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleEscape);
    window.addEventListener("resize", handleResize);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleEscape);
      window.removeEventListener("resize", handleResize);
    };
  }, [position]);

  const open = () => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const target = workspaceMenuPortalTarget(trigger);
    if (!target) return;
    portalRef.current = target;
    const bounds = trigger.getBoundingClientRect();
    const inDrawer = target.matches('.rail-drawer[role="dialog"]');
    const targetBounds = inDrawer ? target.getBoundingClientRect() : null;
    const width = Math.min(320, (targetBounds ? target.clientWidth : window.innerWidth) - 32);
    const bottom = Math.max(16, (targetBounds?.bottom ?? window.innerHeight) - bounds.top + 8);
    setPosition({
      position: inDrawer ? "absolute" : "fixed",
      left: Math.max(16, Math.min(bounds.left - (targetBounds?.left ?? 0), (targetBounds ? target.clientWidth : window.innerWidth) - width - 16)),
      bottom,
      maxHeight: Math.max(0, Math.min(360, (targetBounds ? target.clientHeight : window.innerHeight) - bottom - 16)),
      width,
    });
  };

  const switchWorkspace = async (workspace: WorkspaceMembership) => {
    if (switchingRef.current) return;
    if (workspace.isCurrent) { close(); return; }
    switchingRef.current = true;
    setSwitching(true);
    setError("");
    try {
      const result = await apiFetch<{ workspaceId: string }>("/v1/workspaces/switch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId: workspace.id }),
      });
      setWorkspaceId(result.workspaceId);
      window.location.assign("/app");
    } catch {
      setError("Try switching workspaces again.");
      switchingRef.current = false;
      setSwitching(false);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [])];
    const index = items.findIndex((item) => item === document.activeElement);
    let nextIndex: number;
    if (event.key === "ArrowDown") nextIndex = (index + 1) % items.length;
    else if (event.key === "ArrowUp") nextIndex = (index - 1 + items.length) % items.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = items.length - 1;
    else if (event.key === "Tab") {
      if (portalRef.current?.matches('.rail-drawer[role="dialog"]')) event.preventDefault();
      close();
      return;
    }
    else return;
    event.preventDefault();
    items[nextIndex]?.focus();
  };

  return <>
    <button
      aria-controls={position ? menuId : undefined}
      aria-expanded={Boolean(position)}
      aria-haspopup="menu"
      aria-label={`Switch workspace. Current workspace: ${current?.name ?? "Workspace"}`}
      className="sidebar-footer rail-workspace rail-workspace-trigger"
      id={triggerId}
      onClick={() => position ? close() : open()}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); open(); }
      }}
      ref={triggerRef}
      title={`Switch workspace: ${current?.name ?? "Workspace"}`}
      type="button"
    >
      {children}
      <ChevronDown aria-hidden="true" className="rail-workspace-chevron" size={14} />
    </button>
    {position && portalRef.current ? createPortal(<div className="rail-workspace-menu" ref={menuRef} style={position}>
      <div aria-labelledby={triggerId} aria-busy={switching} id={menuId} onKeyDown={handleKeyDown} role="menu">
        {workspaces.map((workspace) => <button
          aria-checked={workspace.isCurrent}
          aria-disabled={switching}
          className="rail-workspace-option"
          key={workspace.id}
          onClick={() => void switchWorkspace(workspace)}
          role="menuitemradio"
          tabIndex={workspace.isCurrent ? 0 : -1}
          type="button"
        >
          <span><strong>{workspace.name}</strong><small>{workspace.role}</small></span>
          {workspace.isCurrent ? <Check aria-hidden="true" size={16} /> : null}
        </button>)}
      </div>
      {switching ? <p className="rail-workspace-message" role="status">Switching workspace…</p> : null}
      {error ? <p className="rail-workspace-message settings-error" role="alert">{error}</p> : null}
    </div>, portalRef.current) : null}
  </>;
}
