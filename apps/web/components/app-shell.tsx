"use client";

import Link from "next/link";
import { LogOut, Menu, PanelLeftClose, PanelLeftOpen, Search, X } from "lucide-react";
import { usePathname } from "next/navigation";
import posthog from "posthog-js";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ApiHealth } from "@/components/api-health";
import { CommandPalette } from "@/components/command-palette";
import { useEdition } from "@/components/edition-provider";
import { NavIcon } from "@/components/nav-icon";
import { BillingProvider, PlanBanner } from "@/components/plan-picker";
import { Toast } from "@/components/toast";
import { WorkspaceMenu } from "@/components/workspace-menu";
import { apiFetch } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { navItemsForEdition, type NavItem } from "@/lib/navigation";
import { clearWorkspaceId, getWorkspaceId, setWorkspaceId, workspaceMemberships, type WorkspaceMembership } from "@/lib/workspaces";
import { cx } from "@inboxjoy/ui";

type ShellSequence = { status: string };
type ShellInbox = { warmupPercent: number };
type ShellWorkspace = { workspace: { id: string; name: string }; user: { email: string } };

const RAIL_PINNED_KEY = "inboxjoy.sidebar.pinned";
const WARMUP_DISMISSED_KEY = "inboxjoy.sidebar.warmupDismissed";

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const edition = useEdition();
  const { data: session, isPending: sessionPending } = authClient.useSession();
  const [activeCampaigns, setActiveCampaigns] = useState<number | null>(null);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [inboxes, setInboxes] = useState<ShellInbox[]>([]);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [warmupDismissed, setWarmupDismissed] = useState<string | null>(null);
  const [railPinned, setRailPinned] = useState(true);
  const [signOutError, setSignOutError] = useState("");
  const [signingOut, setSigningOut] = useState(false);
  const [workspace, setWorkspace] = useState<ShellWorkspace | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceMembership[]>([]);
  const postHogIdentity = useRef("");
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const mobileDrawerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      const storedRailPinned = window.localStorage.getItem(RAIL_PINNED_KEY);
      setRailPinned(storedRailPinned === null || storedRailPinned === "true");
    } catch {
      setRailPinned(true);
    }
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandPaletteOpen((open) => !open);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Navigating away closes the mobile nav drawer instead of leaving it open
  // underneath the next page.
  useEffect(() => {
    setMobileMenuOpen(false);
  }, [pathname]);

  // While the mobile drawer is open: trap scroll on the body, close on Escape,
  // and move focus into the drawer (returning it to the Menu button on close)
  // so keyboard/AT users never lose their place.
  useEffect(() => {
    if (!mobileMenuOpen) return;
    mobileDrawerRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setMobileMenuOpen(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
      menuButtonRef.current?.focus();
    };
  }, [mobileMenuOpen]);

  useEffect(() => {
    let cancelled = false;
    void apiFetch<unknown>("/v1/workspaces")
      .then((response) => {
        if (cancelled) return;
        const memberships = workspaceMemberships(response);
        const current = memberships.find((membership) => membership.isCurrent);
        if (!getWorkspaceId() && current) setWorkspaceId(current.id);
        setWorkspaces(memberships);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    void Promise.all([
      apiFetch<{ sequences: ShellSequence[] }>("/v1/sequences").catch(() => ({ sequences: [] })),
      apiFetch<{ inboxes: ShellInbox[] }>("/v1/inboxes").catch(() => ({ inboxes: [] })),
      apiFetch<ShellWorkspace>("/v1/workspace").catch(() => null),
    ]).then(([sequenceData, inboxData, workspaceData]) => {
      setActiveCampaigns((sequenceData.sequences as ShellSequence[]).filter((sequence) => sequence.status === "active" || sequence.status === "published").length);
      setInboxes(inboxData.inboxes as ShellInbox[]);
      setWorkspace(workspaceData as ShellWorkspace | null);
    }).catch(() => {
      setActiveCampaigns(null);
      setInboxes([]);
      setWorkspace(null);
    });
  }, []);

  useEffect(() => {
    if (sessionPending || !process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN) return;
    if (!session) {
      if (postHogIdentity.current) posthog.reset();
      postHogIdentity.current = "";
      return;
    }
    if (!workspace?.workspace.id) return;
    const identityKey = `${session.user.id}:${workspace.workspace.id}`;
    if (postHogIdentity.current === identityKey) return;
    postHogIdentity.current = identityKey;
    posthog.identify(session.user.id, { email: session.user.email });
    posthog.group("workspace", workspace.workspace.id);
  }, [session, sessionPending, workspace]);

  useEffect(() => {
    if (!process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN) return;
    const resetPostHog = () => {
      posthog.reset();
      postHogIdentity.current = "";
    };
    window.addEventListener("inboxjoy:signout-succeeded", resetPostHog);
    return () => window.removeEventListener("inboxjoy:signout-succeeded", resetPostHog);
  }, []);

  const warmup = useMemo(() => {
    if (!inboxes.length) return null;
    const percentage = Math.round(inboxes.reduce((sum, inbox) => sum + inbox.warmupPercent, 0) / inboxes.length);
    const ramping = inboxes.filter((inbox) => inbox.warmupPercent < 100).length;
    // Dismissal is keyed to the mailbox count, so connecting a new inbox brings
    // the card back while it ramps, and again once it completes.
    return { percentage, complete: ramping === 0, key: `${workspace?.workspace.id}:complete:${inboxes.length}`, copy: ramping ? `${ramping} mailbox${ramping === 1 ? " is" : "es are"} still ramping.` : `${inboxes.length} mailbox${inboxes.length === 1 ? " is" : "es are"} at full volume.` };
  }, [inboxes, workspace?.workspace.id]);

  useEffect(() => {
    try {
      setWarmupDismissed(window.localStorage.getItem(WARMUP_DISMISSED_KEY));
    } catch {
      setWarmupDismissed(null);
    }
  }, []);

  const dismissWarmup = () => {
    if (!warmup || !workspace?.workspace.id) return;
    setWarmupDismissed(warmup.key);
    try {
      window.localStorage.setItem(WARMUP_DISMISSED_KEY, warmup.key);
    } catch {
      // Private mode: the card stays hidden for this session only.
    }
  };

  const showWarmup = warmup && !(warmup.complete && warmupDismissed === warmup.key);

  const identity = workspace?.user.email || workspace?.workspace.name || "InboxJoy";
  const initials = identity.split(/[@\s]+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "IJ";
  const editionNavItems = navItemsForEdition(edition);
  const primaryNavItems = editionNavItems.filter((item) => item.icon !== "settings" && item.icon !== "docs");
  const secondaryNavItems = editionNavItems.filter((item) => item.icon === "settings" || item.icon === "docs");
  const workspaceIdentity = <>
    <span className="sidebar-avatar">{initials}</span>
    <span className="sidebar-workspace rail-label">
      <strong>{workspaces.length > 1 ? workspaces.find((item) => item.isCurrent)?.name : workspace?.workspace.name ?? "Workspace"}</strong>
      <small>{workspace?.user.email ?? "InboxJoy"}</small>
    </span>
    <ApiHealth />
  </>;

  const toggleRailPin = () => {
    setRailPinned((pinned) => {
      const nextPinned = !pinned;
      try {
        window.localStorage.setItem(RAIL_PINNED_KEY, String(nextPinned));
      } catch {
        return nextPinned;
      }
      return nextPinned;
    });
  };

  const signOut = async () => {
    setSigningOut(true);
    setSignOutError("");
    try {
      const result = (await authClient.signOut()) as { error?: { message?: string } | null } | undefined;
      if (result?.error) throw new Error(result.error.message ?? "Could not log out.");
      clearWorkspaceId();
      window.location.assign("/");
    } catch {
      setSignOutError("Could not log out. Please try again.");
      setSigningOut(false);
    }
  };

  const renderNavItem = (item: NavItem) => {
    const active = pathname === item.href || (item.href !== "/app" && pathname.startsWith(`${item.href}/`));
    const badge = item.href === "/app/sequences" ? activeCampaigns : null;

    return (
      <Link aria-current={active ? "page" : undefined} className={cx("nav-link", "rail-link", active && "nav-link--active")} href={item.href} key={item.href} rel={item.newTab ? "noopener" : undefined} target={item.newTab ? "_blank" : undefined} title={item.label}>
        <span className="nav-label"><NavIcon name={item.icon} /><span className="rail-label">{item.label}</span></span>
        {badge ? <span className="nav-badge rail-badge">{badge}</span> : null}
      </Link>
    );
  };

  // Shared between the desktop/tablet rail (<aside>) and the <=640px slide-in
  // drawer so the two surfaces never drift out of sync: primary + secondary
  // nav (including Settings, Docs, Log out), the campaign count badge, the
  // warm-up status card, and the workspace/user block.
  const railBody = (
    <>
      <div className="rail-scroll">
        <nav className="nav-list rail-nav" aria-label="Primary navigation">
          {primaryNavItems.map(renderNavItem)}
        </nav>

        {warmup && showWarmup ? <div className="sidebar-warmup rail-warmup">
          {warmup.complete ? <button aria-label="Dismiss warm-up notice" className="rail-warmup-dismiss" onClick={dismissWarmup} title="Dismiss" type="button"><X aria-hidden="true" size={15} strokeWidth={2} /></button> : null}
          <div>
            <strong>{warmup.complete ? "Warm-up complete" : "Warm-up in progress"}</strong>
            <span>{warmup.copy}</span>
          </div>
          <div className="sidebar-warmup-bar"><span style={{ width: `${warmup.percentage}%` }} /></div>
        </div> : null}
      </div>

      <div className="rail-bottom">
        <nav className="nav-list rail-nav rail-nav--secondary" aria-label="Secondary navigation">
          {secondaryNavItems.map(renderNavItem)}
        </nav>
        <button className="nav-link rail-link rail-logout" disabled={signingOut} onClick={() => void signOut()} title="Log out" type="button">
          <span className="nav-label"><LogOut aria-hidden="true" className="nav-icon" size={20} strokeWidth={1.75} /><span className="rail-label">{signingOut ? "Logging out…" : "Log out"}</span></span>
        </button>
        <div className="rail-divider" />
        {workspaces.length > 1 ? <WorkspaceMenu resetKey={`${pathname}:${mobileMenuOpen}:${railPinned}:${commandPaletteOpen}`} workspaces={workspaces}>{workspaceIdentity}</WorkspaceMenu> : <div className="sidebar-footer rail-workspace" title={identity}>{workspaceIdentity}</div>}
      </div>
    </>
  );

  return (
    <div className={cx("app-shell", "rail-app-shell", railPinned && "rail-app-shell--pinned")}>
      <BillingProvider>
        {/* <=640px only (hidden via CSS above that): a compact sticky bar
            replacing the rail, since a 60px-wide vertical rail collapsed
            further into a horizontal strip is what caused the old
            everything-clips-to-one-letter mobile bug. */}
        <header className="rail-topbar">
          <Link aria-label="InboxJoy dashboard" className="rail-topbar-brand" href="/app" title="InboxJoy dashboard">
            <span className="brand-mark">
              <img alt="InboxJoy" height={28} src="/brand/icon-64x64.png" style={{ borderRadius: 7 }} width={28} />
            </span>
          </Link>
          <div className="rail-topbar-actions">
            <button aria-label="Search commands" className="rail-topbar-btn" onClick={() => setCommandPaletteOpen(true)} title="Search commands" type="button">
              <Search aria-hidden="true" size={20} strokeWidth={1.75} />
            </button>
            <button aria-controls="rail-mobile-drawer" aria-expanded={mobileMenuOpen} aria-label={mobileMenuOpen ? "Close menu" : "Open menu"} className="rail-topbar-btn" onClick={() => setMobileMenuOpen((open) => !open)} ref={menuButtonRef} type="button">
              {mobileMenuOpen ? <X aria-hidden="true" size={22} strokeWidth={1.75} /> : <Menu aria-hidden="true" size={22} strokeWidth={1.75} />}
            </button>
          </div>
        </header>

        {/* Rendered as fixed-position siblings at the shell root (outside
            <main>, never inside a page's own animated root) so a page-enter
            transform never becomes their containing block — see the
            position:fixed + animated-ancestor trap in
            docs/regression-guardrails.md. */}
        <div aria-hidden="true" className={cx("rail-drawer-backdrop", mobileMenuOpen && "rail-drawer-backdrop--open")} onClick={() => setMobileMenuOpen(false)} />
        <div aria-hidden={!mobileMenuOpen} aria-label="Navigation menu" aria-modal="true" className={cx("rail-drawer", mobileMenuOpen && "rail-drawer--open")} id="rail-mobile-drawer" ref={mobileDrawerRef} role="dialog" tabIndex={-1}>
          {railBody}
        </div>

        <aside className={cx("sidebar", "rail-sidebar")}>
          <div className="rail-top">
            <div className="rail-brand-row">
              <Link className="brand rail-brand" href="/app" aria-label="InboxJoy dashboard" title="InboxJoy dashboard">
                <span className="brand-mark">
                  <img src="/brand/icon-64x64.png" alt="InboxJoy" width={32} height={32} style={{ borderRadius: 8 }} />
                </span>
                <span className="rail-label">
                  <strong>InboxJoy</strong>
                </span>
              </Link>
              <button aria-label={railPinned ? "Collapse sidebar" : "Expand sidebar"} aria-pressed={railPinned} className="rail-pin-icon" onClick={toggleRailPin} title={railPinned ? "Collapse sidebar" : "Expand sidebar"} type="button">
                {railPinned ? <PanelLeftClose aria-hidden="true" size={18} /> : <PanelLeftOpen aria-hidden="true" size={18} />}
              </button>
            </div>

            <button className="rail-search" onClick={() => setCommandPaletteOpen(true)} title="Search commands" type="button">
              <Search aria-hidden="true" className="rail-search-icon" size={20} strokeWidth={1.75} />
              <span className="rail-label">Search</span>
              <kbd className="rail-shortcut">⌘K</kbd>
            </button>
          </div>

          {railBody}
        </aside>

        <main className="main-content">
          <PlanBanner />
          {children}
        </main>
        {signOutError ? <Toast tone="error" message={signOutError} onDismiss={() => setSignOutError("")} /> : null}
        <CommandPalette open={commandPaletteOpen} onOpenChange={setCommandPaletteOpen} />
      </BillingProvider>
    </div>
  );
}
