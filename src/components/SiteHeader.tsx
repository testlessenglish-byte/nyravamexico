import { Link } from "@tanstack/react-router";
import { NyravaLogo } from "./NyravaLogo";
import { useSession } from "@/hooks/use-session";
import { useI18n } from "@/i18n";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { MobileNav } from "./MobileNav";
import { PUBLIC_NAV_ITEMS } from "@/lib/public-navigation";

export function SiteHeader() {
  const { user } = useSession();
  const { t } = useI18n();

  const NAV = PUBLIC_NAV_ITEMS.map((item) => ({ label: t(item.labelKey), to: item.to }));

  return (
    <header className="sticky top-0 z-40 border-b border-border/60 bg-background/70 backdrop-blur-xl">
      <div className="mx-auto grid max-w-[100rem] grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 sm:px-6 sm:py-4 xl:flex xl:justify-between">
        <Link to="/" className="flex min-w-0 items-center">
          <NyravaLogo size={48} withWordmark className="min-w-0 sm:[&>div:first-child]:h-14 sm:[&>div:first-child]:w-14" />
        </Link>
        <nav className="hidden items-center gap-6 xl:flex 2xl:gap-8">
          {NAV.map((n) => (
            <Link
              key={n.to}
              to={n.to}
              className="text-[11px] font-semibold tracking-[0.18em] text-muted-foreground transition hover:text-foreground"
            >
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="flex shrink-0 items-center justify-end gap-2 sm:gap-3">
          <div className="hidden xl:block"><LanguageSwitcher /></div>
          {user ? (
            <Link
              to="/dashboard"
                className="hidden items-center gap-2 rounded-md bg-primary px-4 py-2 text-[11px] font-bold tracking-[0.14em] text-primary-foreground transition hover:brightness-105 xl:inline-flex"
              style={{ boxShadow: "var(--shadow-glow-cyan)" }}
            >
              {t("nav.openWorkspace")}
            </Link>
          ) : (
            <>
              <Link
                to="/auth"
                className="hidden items-center rounded-md border border-border px-3 py-2 text-[11px] font-semibold tracking-[0.16em] text-foreground transition hover:border-primary/50 hover:text-primary xl:inline-flex"
              >
                {t("nav.signIn")}
              </Link>
              <Link
                to="/auth"
                className="hidden items-center gap-2 rounded-md bg-primary px-4 py-2 text-[11px] font-bold tracking-[0.14em] text-primary-foreground transition hover:brightness-105 xl:inline-flex"
                style={{ boxShadow: "var(--shadow-glow-cyan)" }}
              >
                {t("nav.openPlatform")}
              </Link>
            </>
          )}
          <MobileNav items={NAV}>
            <LanguageSwitcher variant="sidebar" className="w-full justify-start" />
            {user ? (
              <Link
                to="/dashboard"
                className="rounded-md bg-primary px-3 py-2 text-center text-[11px] font-bold tracking-[0.14em] text-primary-foreground"
              >
                {t("nav.openWorkspace")}
              </Link>
            ) : (
              <>
                <Link
                  to="/auth"
                  className="rounded-md border border-border px-3 py-2 text-center text-[11px] font-semibold tracking-[0.14em] text-foreground"
                >
                  {t("nav.signIn")}
                </Link>
                <Link
                  to="/auth"
                  className="rounded-md bg-primary px-3 py-2 text-center text-[11px] font-bold tracking-[0.14em] text-primary-foreground"
                >
                  {t("nav.openPlatform")}
                </Link>
              </>
            )}
          </MobileNav>
        </div>

      </div>
    </header>
  );
}
