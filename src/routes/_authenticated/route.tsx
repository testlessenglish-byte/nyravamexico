import {
  createFileRoute,
  Link,
  Outlet,
  redirect,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import { useEffect, useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { checkIsAdmin, listCases } from "@/lib/cases.functions";
import {
  LayoutDashboard,
  FolderOpen,
  Plus,
  MessageSquare,
  FileSearch,
  Clock,
  Users,
  User,
  FileText,
  Gavel,
  Target,
  Bell,
  Settings,
  ShieldCheck,
  Activity,
  LogOut,
  HelpCircle,
  Mic,
  Search,
  Menu,
  X,
  Sparkles,
  HeartHandshake,
} from "lucide-react";
import { NyravaLogo } from "@/components/NyravaLogo";
import { TrustStrip } from "@/components/TrustStrip";
import { useUnreadMessages } from "@/hooks/useUnreadMessages";
import { useReminderNotifications } from "@/hooks/useReminderNotifications";
import { ScrollToTop } from "@/components/ScrollToTop";
import { FeedbackButton } from "@/components/FeedbackButton";
import { getProfileSetupStatus } from "@/lib/account.functions";

import { BackButton } from "@/components/BackButton";
import { UserMenu } from "@/components/UserMenu";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { useI18n } from "@/i18n";
import { useGlobalPipelineDriver } from "@/hooks/useGlobalPipelineDriver";
import { ConsentGate } from "@/components/compliance/ConsentGate";

async function getAuthenticatedUser() {
  if (typeof window === "undefined") return null;

  // 1. Fast check: try getSession first (often instant if cached in memory/localStorage)
  try {
    const { data: sessionData } = await supabase.auth.getSession();
    if (sessionData?.session?.user) {
      return sessionData.session.user;
    }
  } catch {
    // ignore initial read error
  }

  // 2. Retry window for session re-hydration:
  // On hard refresh (especially in Lovable preview iframe or during token restore),
  // storage synchronization over postMessage or storage load can take 100-600ms.
  // We poll up to 3 times before giving up.
  for (let attempt = 0; attempt < 3; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 250 : 500));
    try {
      const { data: retrySession } = await supabase.auth.getSession();
      if (retrySession?.session?.user) {
        return retrySession.session.user;
      }
      const { data: userData } = await supabase.auth.getUser();
      if (userData?.user) {
        return userData.user;
      }
    } catch {
      // continue waiting
    }
  }

  return null;
}

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Workspace — Nyrava Intelligence OS" },
      {
        name: "description",
        content:
          "Your Nyrava workspace: cases, evidence, motions, timelines, witnesses, and reports.",
      },
      { name: "robots", content: "noindex, nofollow" },
      { property: "og:title", content: "Workspace — Nyrava Intelligence OS" },
      {
        property: "og:description",
        content:
          "Your Nyrava workspace: cases, evidence, motions, timelines, witnesses, and reports.",
      },
    ],
  }),
  beforeLoad: async ({ location }) => {
    if (location.pathname.startsWith("/lovable/")) return;
    const user = await getAuthenticatedUser();
    if (!user) {
      const target = `${location.pathname}${location.searchStr ? `?${location.searchStr}` : ""}`;
      throw redirect({
        to: "/auth",
        search: target && target !== "/" && target !== "/auth" ? { redirect: target } : undefined,
      });
    }
    return { user };
  },
  component: AppLayout,
});

// Nav labels are i18n keys resolved at render time (see NavItem) so the
// sidebar switches language with the rest of the shell.
const PRIMARY_NAV = [
  { to: "/dashboard", labelKey: "nav.missionControl", icon: LayoutDashboard },
  { to: "/cases", labelKey: "nav.caseIntelligence", icon: FolderOpen },
  { to: "/social", labelKey: "nav.comprehensiveCare", icon: HeartHandshake },
  { to: "/new", labelKey: "nav.analyzeNewCase", icon: Plus },
] as const;

const INTEL_NAV = [
  { to: "/talk", labelKey: "nav.talkToCases", icon: MessageSquare },
  { to: "/evidence", labelKey: "nav.evidenceExplorer", icon: FileSearch },
  { to: "/timeline", labelKey: "nav.timelineBuilder", icon: Clock },
  { to: "/witness", labelKey: "nav.witnessIntelligence", icon: Users },
] as const;

const OUTPUT_NAV = [
  { to: "/reports", labelKey: "nav.reports", icon: FileText },
  { to: "/motion", labelKey: "nav.motionIntelligence", icon: Gavel },
  { to: "/strategy", labelKey: "nav.strategyCenter", icon: Target },
  { to: "/alerts", labelKey: "nav.alerts", icon: Bell },
] as const;

type MobileTabTo = "/dashboard" | "/cases" | "/talk" | "/reports" | "/settings";
const MOBILE_TABS: Array<{
  to: MobileTabTo;
  labelKey: string;
  icon: typeof LayoutDashboard;
  primary?: boolean;
}> = [
  { to: "/dashboard", labelKey: "nav.tab.dashboard", icon: LayoutDashboard },
  { to: "/cases", labelKey: "nav.tab.cases", icon: FolderOpen },
  { to: "/talk", labelKey: "nav.tab.companion", icon: Mic, primary: true },
  { to: "/reports", labelKey: "nav.tab.reports", icon: FileText },
  { to: "/settings", labelKey: "nav.tab.settings", icon: Settings },
];

function AppLayout() {
  const { t } = useI18n();
  // Navigation-independent pipeline driving: loops live in module state, so
  // switching pages or cases never pauses an active run (one loop per case).
  useGlobalPipelineDriver();
  const nav = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [email, setEmail] = useState<string>("");
  const [fullName, setFullName] = useState<string>("");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const fetchIsAdmin = useServerFn(checkIsAdmin);
  const fetchCases = useServerFn(listCases);

  // Global search — previously a fully inert <input> with no state, no
  // handler, and nothing wired to it, so typing produced no results
  // regardless of what matched. Reuses the same ["cases"] query key as
  // the dashboard (react-query dedupes/caches it) so this doesn't add an
  // extra network round trip beyond what the dashboard already fetches.
  const [searchQuery, setSearchQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const { data: searchableCases } = useQuery({
    queryKey: ["cases"],
    queryFn: () => fetchCases(),
    staleTime: 30000,
  });
  const searchResults = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [];
    return (searchableCases ?? [])
      .filter(
        (c) =>
          !c.archived_at && (c.name.toLowerCase().includes(q) || c.id.toLowerCase().includes(q)),
      )
      .slice(0, 8);
  }, [searchableCases, searchQuery]);

  // Close drawer on route change
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data }) => {
      const user = data.session?.user;
      setEmail(user?.email ?? "");
      const metaName =
        (user?.user_metadata?.full_name as string | undefined) ||
        (user?.user_metadata?.name as string | undefined) ||
        "";
      if (metaName) setFullName(metaName);
      if (user?.id) {
        const { data: prof } = await supabase
          .from("profiles")
          .select("full_name")
          .eq("id", user.id)
          .maybeSingle();
        if (prof?.full_name) setFullName(prof.full_name);
      }
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") nav({ to: "/auth", replace: true });
    });
    return () => sub.subscription.unsubscribe();
  }, [nav]);

  const { data: adminInfo } = useQuery({
    queryKey: ["isAdmin"],
    queryFn: () => fetchIsAdmin(),
    staleTime: 5 * 60 * 1000,
  });

  // Beta testers get the full product but must register a real professional
  // profile first. Everyone else is untouched by this gate.
  const fetchProfileStatus = useServerFn(getProfileSetupStatus);
  const { data: profileStatus } = useQuery({
    queryKey: ["profile-setup-status"],
    queryFn: () => fetchProfileStatus(),
    staleTime: 60000,
  });
  useEffect(() => {
    if (!profileStatus?.isBetaTester || profileStatus.complete) return;
    if (pathname === "/profile-setup" || pathname === "/onboarding") return;
    nav({ to: "/profile-setup", replace: true });
  }, [profileStatus, pathname, nav]);

  // Header bell is dedicated to the message/support system (Comentarios +
  // Ayuda y soporte) — NOT case pipeline/finding alerts, which already
  // surface inside each case's own Reports/Findings tabs and stay reachable
  // from the "Alerts & Briefings" sidebar link (still /alerts) on its own.
  // See src/hooks/useUnreadMessages.ts.
  const { unreadCount } = useUnreadMessages(!!adminInfo?.isAdmin);
  const unreadLabel = unreadCount > 9 ? "9+" : String(unreadCount);
  const messagesLink = adminInfo?.isAdmin ? "/admin/messages" : "/messages";

  // Desktop notifications for due reminders (hearings/events + task
  // deadlines) the user opted into. Runs app-wide, not just on /dashboard,
  // so a reminder still fires while the attorney is working a different case.
  useReminderNotifications(true);

  const displayName = fullName || email.split("@")[0] || "";
  const initials = (
    displayName
      .split(/\s+/)
      .filter(Boolean)
      .map((p) => p[0])
      .join("")
      .slice(0, 2) || "U"
  ).toUpperCase();
  // The greeting depends on the *viewer's* clock. Computing it during render
  // makes SSR use the server's hour and the browser use the attorney's local
  // hour, which is a guaranteed hydration mismatch whenever the two fall in
  // different buckets (the "Buenos días" / "Buenas noches" React error).
  // Resolve it only after hydration; before that both sides render "".
  const [localHour, setLocalHour] = useState<number | null>(null);
  useEffect(() => {
    setLocalHour(new Date().getHours());
  }, []);
  const greeting =
    localHour === null
      ? ""
      : localHour < 12
        ? t("shell.greeting.morning")
        : localHour < 18
          ? t("shell.greeting.afternoon")
          : t("shell.greeting.evening");

  const firstName =
    fullName.split(/\s+/)[0] || email.split("@")[0]?.split(".")[0] || t("shell.counsel");

  const NavItem = ({
    to,
    label,
    labelKey,
    icon: Icon,
  }: {
    to: string;
    label?: string;
    labelKey?: string;
    icon: typeof LayoutDashboard;
  }) => {
    const text = labelKey ? t(labelKey) : (label ?? "");
    const active = pathname === to;
    return (
      <Link
        to={to}
        className={`group flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-all ${
          active
            ? "bg-sidebar-accent text-sidebar-accent-foreground ring-1 ring-primary/30"
            : "text-sidebar-foreground/80 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
        }`}
      >
        <Icon
          className={`h-4 w-4 shrink-0 ${active ? "text-primary" : "text-sidebar-foreground/60 group-hover:text-primary"}`}
        />
        <span className="truncate">{text}</span>
      </Link>
    );
  };

  return (
    <div className="flex min-h-screen flex-col bg-background md:h-screen md:min-h-0 md:flex-row md:overflow-hidden">
      {/* Mobile top bar */}
      <header className="sticky top-0 z-30 flex items-center justify-between border-b border-sidebar-border bg-sidebar/95 px-4 py-3 backdrop-blur md:hidden">
        <button
          onClick={() => setDrawerOpen(true)}
          aria-label={t("shell.menu.open")}
          className="rounded-md p-1.5 text-sidebar-foreground/80 hover:bg-sidebar-accent"
        >
          <Menu className="h-5 w-5" />
        </button>
        <NyravaLogo size={28} withWordmark />
        <div className="flex items-center gap-2">
          <Link
            to={messagesLink}
            className="relative rounded-md p-1.5 text-sidebar-foreground/80 hover:bg-sidebar-accent"
            aria-label={t("shell.notifications")}
          >
            <Bell className="h-5 w-5" />
            {unreadCount > 0 && (
              <span className="absolute right-0.5 top-0.5 grid h-4 w-4 place-items-center rounded-full bg-destructive text-[9px] font-bold text-destructive-foreground">
                {unreadLabel}
              </span>
            )}
          </Link>
          <LanguageSwitcher variant="header" />
          <UserMenu
            initials={initials}
            displayName={displayName}
            email={email}
            isAdmin={!!adminInfo?.isAdmin}
          />
        </div>
      </header>

      {/* Mobile slide-out drawer */}
      {drawerOpen && (
        <div className="fixed inset-0 z-50 md:hidden" role="dialog" aria-modal="true">
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setDrawerOpen(false)}
          />
          <aside className="absolute left-0 top-0 flex h-full w-[82%] max-w-[320px] flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground shadow-2xl animate-in slide-in-from-left duration-200">
            <div className="flex items-center justify-between border-b border-sidebar-border px-4 py-3">
              <NyravaLogo size={30} withWordmark />
              <button
                onClick={() => setDrawerOpen(false)}
                aria-label={t("shell.menu.close")}
                className="rounded-md p-1.5 text-sidebar-foreground/80 hover:bg-sidebar-accent"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="flex items-center gap-3 border-b border-sidebar-border px-4 py-3">
              <div className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-gradient-to-br from-primary to-accent text-sm font-bold text-primary-foreground">
                {initials}
              </div>
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold">{firstName}</div>
                <div className="truncate text-[11px] text-sidebar-foreground/60">
                  {adminInfo?.isAdmin ? t("nav.role.admin") : t("nav.role.attorney")}
                </div>
              </div>
            </div>
            <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-4">
              <div className="space-y-1">
                <div className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-[0.22em] text-sidebar-foreground/40">
                  {t("nav.section.command")}
                </div>
                {PRIMARY_NAV.map((it) => (
                  <NavItem key={it.to} {...it} />
                ))}
              </div>
              <div className="space-y-1">
                <div className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-[0.22em] text-sidebar-foreground/40">
                  {t("nav.section.intelligence")}
                </div>
                {INTEL_NAV.map((it) => (
                  <NavItem key={it.to} {...it} />
                ))}
              </div>
              <div className="space-y-1">
                <div className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-[0.22em] text-sidebar-foreground/40">
                  {t("nav.section.output")}
                </div>
                {OUTPUT_NAV.map((it) => (
                  <NavItem key={it.to} {...it} />
                ))}
              </div>
              <div className="space-y-1">
                <div className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-sidebar-foreground/40">
                  {t("nav.section.system")}
                </div>
                <NavItem to="/account" labelKey="nav.account" icon={User} />
                <NavItem to="/security-dashboard" labelKey="nav.security" icon={ShieldCheck} />
                <NavItem to="/ai-keys" labelKey="nav.aiKeys" icon={Sparkles} />
                <NavItem to="/health" labelKey="nav.health" icon={Activity} />
                {adminInfo?.isAdmin && (
                  <NavItem to="/admin" labelKey="nav.adminPanel" icon={ShieldCheck} />
                )}
                <Link
                  to="/settings"
                  className="group flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-sidebar-foreground/80 hover:bg-sidebar-accent/50"
                >
                  <HelpCircle className="h-4 w-4 shrink-0 text-sidebar-foreground/60" />
                  <span>{t("nav.help")}</span>
                </Link>
              </div>
            </nav>
            <div className="border-t border-sidebar-border p-3">
              <button
                onClick={async () => {
                  try {
                    await supabase.auth.signOut({ scope: "global" });
                  } catch {}
                  try {
                    await supabase.auth.signOut({ scope: "local" });
                  } catch {}
                  if (typeof window !== "undefined") {
                    try {
                      localStorage.clear();
                      sessionStorage.clear();
                    } catch {}
                    window.location.replace("/auth?logged_out=1");
                  }
                }}
                className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-sidebar-foreground/80 hover:bg-sidebar-accent/50"
              >
                <LogOut className="h-4 w-4 shrink-0 text-sidebar-foreground/60" />
                <span>{t("nav.logout")}</span>
              </button>
            </div>
          </aside>
        </div>
      )}

      {/* Desktop sidebar */}
      <aside className="hidden w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground md:flex">
        <div className="flex items-center gap-2 px-5 py-5 border-b border-sidebar-border">
          <NyravaLogo size={36} withWordmark />
        </div>
        <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-4">
          <div className="space-y-1">
            <div className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-[0.22em] text-sidebar-foreground/40">
              {t("nav.section.command")}
            </div>
            {PRIMARY_NAV.map((it) => (
              <NavItem key={it.to} {...it} />
            ))}
          </div>
          <div className="space-y-1">
            <div className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-[0.22em] text-sidebar-foreground/40">
              {t("nav.section.intelligence")}
            </div>
            {INTEL_NAV.map((it) => (
              <NavItem key={it.to} {...it} />
            ))}
          </div>
          <div className="space-y-1">
            <div className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-[0.22em] text-sidebar-foreground/40">
              {t("nav.section.output")}
            </div>
            {OUTPUT_NAV.map((it) => (
              <NavItem key={it.to} {...it} />
            ))}
          </div>
          <div className="space-y-1">
            <div className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-[0.22em] text-sidebar-foreground/40">
              {t("nav.section.system")}
            </div>
            <NavItem to="/account" labelKey="nav.account" icon={User} />
            <NavItem to="/security-dashboard" labelKey="nav.security" icon={ShieldCheck} />
            <NavItem to="/ai-keys" labelKey="nav.aiKeys" icon={Sparkles} />
            <NavItem to="/health" labelKey="nav.health" icon={Activity} />
            {adminInfo?.isAdmin && <NavItem to="/admin" labelKey="nav.admin" icon={ShieldCheck} />}
            <Link
              to="/settings"
              className="group flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-sidebar-foreground/80 hover:bg-sidebar-accent/50"
            >
              <HelpCircle className="h-4 w-4 shrink-0 text-sidebar-foreground/60" />
              <span>{t("nav.help")}</span>
            </Link>
          </div>
        </nav>
        <div className="border-t border-sidebar-border p-3">
          <div className="flex items-center gap-3 rounded-lg bg-sidebar-accent/40 p-2.5">
            <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-gradient-to-br from-primary to-accent text-[12px] font-bold text-primary-foreground">
              {initials}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs font-semibold text-sidebar-foreground">
                {firstName}
              </div>
              <div className="truncate text-[10px] text-sidebar-foreground/60">
                {adminInfo?.isAdmin ? t("nav.role.admin") : t("nav.role.attorney")}
              </div>
            </div>
            <button
              onClick={async () => {
                try {
                  await supabase.auth.signOut({ scope: "global" });
                } catch {}
                try {
                  await supabase.auth.signOut({ scope: "local" });
                } catch {}
                if (typeof window !== "undefined") {
                  try {
                    localStorage.clear();
                    sessionStorage.clear();
                  } catch {}
                  window.location.replace("/auth?logged_out=1");
                }
              }}
              className="rounded-md p-1.5 text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground"
              aria-label={t("nav.logout")}
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Desktop top bar */}
        <header className="sticky top-0 z-20 hidden items-center gap-4 border-b border-border bg-card/70 px-6 py-3 backdrop-blur md:flex">
          {pathname !== "/dashboard" && <BackButton />}
          <div className="flex items-center gap-3">
            <div className="grid h-9 w-9 place-items-center rounded-full bg-warning/15 text-warning">
              ☀
            </div>
            <div>
              <div className="text-base font-semibold text-foreground">
                {greeting ? `${greeting}, ${firstName}.` : `${firstName}.`}
              </div>
            </div>
          </div>
          <div className="ml-auto flex items-center gap-3">
            <div className="relative w-80">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setSearchOpen(true);
                }}
                onFocus={() => setSearchOpen(true)}
                // Delay so a click on a result fires before the dropdown
                // unmounts — a plain onBlur closing immediately would
                // swallow the click.
                onBlur={() => setTimeout(() => setSearchOpen(false), 150)}
                placeholder={t("shell.search.placeholder")}
                className="w-full rounded-lg border border-border bg-input/40 py-2 pl-9 pr-3 text-sm placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              />
              {searchOpen && searchQuery.trim() && (
                <div className="absolute left-0 right-0 top-full z-40 mt-1 max-h-80 overflow-auto rounded-lg border border-border bg-popover shadow-lg">
                  {searchResults.length === 0 ? (
                    <div className="px-3 py-3 text-xs text-muted-foreground">
                      {t("shell.search.noMatches", { query: searchQuery })}
                    </div>
                  ) : (
                    searchResults.map((c) => (
                      <Link
                        key={c.id}
                        to="/cases/$caseId"
                        params={{ caseId: c.id }}
                        className="block truncate border-b border-border px-3 py-2 text-sm last:border-b-0 hover:bg-accent/10"
                        onClick={() => {
                          setSearchQuery("");
                          setSearchOpen(false);
                        }}
                      >
                        <span className="font-medium text-foreground">{c.name}</span>
                        <span className="ml-2 text-xs text-muted-foreground">
                          {t(`cases.status.${c.status}`)}
                        </span>
                      </Link>
                    ))
                  )}
                </div>
              )}
            </div>
            <Link
              to={messagesLink}
              className="relative rounded-lg border border-border bg-card/60 p-2 hover:bg-card"
              aria-label={t("shell.notifications")}
            >
              <Bell className="h-4 w-4 text-foreground" />
              {unreadCount > 0 && (
                <span className="absolute -right-1 -top-1 grid h-4 w-4 place-items-center rounded-full bg-destructive text-[9px] font-bold text-destructive-foreground">
                  {unreadLabel}
                </span>
              )}
            </Link>
            <LanguageSwitcher variant="header" />
            <UserMenu
              initials={initials}
              displayName={displayName}
              email={email}
              isAdmin={!!adminInfo?.isAdmin}
            />
          </div>
        </header>

        <main className="min-w-0 flex-1 overflow-auto pb-20 md:pb-0">
          <Outlet />
          <TrustStrip />
          <ConsentGate />
        </main>

        {/* Mobile bottom tabs */}
        <nav className="fixed bottom-0 left-0 right-0 z-30 grid grid-cols-5 gap-1 border-t border-sidebar-border bg-sidebar/95 px-2 pb-2 pt-2 backdrop-blur md:hidden">
          {MOBILE_TABS.map(({ to, labelKey, icon: Icon, primary }) => {
            const label = t(labelKey);
            if (primary) {
              return (
                <Link
                  key={label}
                  to={to}
                  className="flex flex-col items-center justify-center gap-1"
                >
                  <span className="grid h-12 w-12 -translate-y-3 place-items-center rounded-full bg-gradient-to-br from-primary to-accent text-primary-foreground shadow-[0_8px_24px_oklch(0.78_0.16_220/0.45)] ring-4 ring-sidebar">
                    <Icon className="h-5 w-5" />
                  </span>
                  <span className="-translate-y-3 text-[10px] font-semibold text-primary">
                    {label}
                  </span>
                </Link>
              );
            }
            const active = pathname === to;
            return (
              <Link
                key={label}
                to={to}
                className={`flex flex-col items-center justify-center gap-1 rounded-md py-1 text-[10px] ${active ? "text-primary" : "text-sidebar-foreground/70"}`}
              >
                <Icon className="h-5 w-5" />
                <span>{label}</span>
              </Link>
            );
          })}
        </nav>
      </div>
      <ScrollToTop />
      <FeedbackButton />
    </div>
  );
}
