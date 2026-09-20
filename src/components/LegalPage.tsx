import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { NyravaLogo } from "./NyravaLogo";
import { SiteFooter } from "./SiteFooter";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { MobileNav } from "./MobileNav";
import { useI18n } from "@/i18n";
import { PUBLIC_NAV_ITEMS } from "@/lib/public-navigation";

type Props = {
  eyebrow?: string;
  title: string;
  updated?: string;
  intro?: ReactNode;
  children: ReactNode;
};

/**
 * Shared shell for public legal / policy / support pages.
 * Uses the same dark visual language as the landing page.
 */
export function LegalPage({ eyebrow, title, updated, intro, children }: Props) {
  const { t } = useI18n();
  const navItems = PUBLIC_NAV_ITEMS.map((item) => ({ label: t(item.labelKey), to: item.to }));
  return (
    <div className="min-h-screen text-foreground">
      <header className="border-b border-border/60">
        <div className="mx-auto grid max-w-7xl grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-4 sm:px-6 sm:py-5 xl:flex xl:justify-between">
          <Link to="/" className="flex min-w-0 items-center gap-2" aria-label="Nyrava home">
            <NyravaLogo size={36} withWordmark />
          </Link>
          <nav className="hidden items-center gap-2 xl:flex">
            <LanguageSwitcher />
            <Link
              to="/auth"
              className="rounded-md border border-border bg-card/60 px-4 py-2 text-[11px] font-semibold tracking-[0.16em] text-foreground hover:bg-card"
            >
              {t("nav.signIn")}
            </Link>
          </nav>
          <MobileNav items={navItems}>
            <LanguageSwitcher variant="sidebar" className="w-full justify-start" />
            <Link to="/auth" className="rounded-md border border-border px-3 py-2 text-center text-[11px] font-semibold tracking-[0.14em] text-foreground">
              {t("nav.signIn")}
            </Link>
            <Link to="/auth" className="rounded-md bg-primary px-3 py-2 text-center text-[11px] font-bold tracking-[0.14em] text-primary-foreground">
              {t("nav.openPlatform")}
            </Link>
          </MobileNav>
        </div>
      </header>

      <main className="mx-auto min-w-0 max-w-3xl px-4 py-10 sm:px-6 md:py-16">
        {eyebrow && (
          <div className="mb-3 text-[10.5px] font-semibold uppercase tracking-[0.28em] text-primary">
            {eyebrow}
          </div>
        )}
        <h1 className="break-words font-display text-3xl font-semibold leading-tight tracking-normal md:text-4xl">
          {title}
        </h1>
        {updated && (
          <div className="mt-2 text-[12px] text-muted-foreground">{t("legal.lastUpdated")} {updated}</div>
        )}
        {intro && (
          <div className="mt-6 text-[14px] leading-relaxed text-muted-foreground">{intro}</div>
        )}
        <div className="legal-prose mt-8 min-w-0 space-y-8 break-words">{children}</div>
      </main>

      <SiteFooter />
    </div>
  );
}

export function Section({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="text-lg font-semibold text-foreground">{heading}</h2>
      <div className="mt-3 space-y-3 text-[13.5px] leading-relaxed text-muted-foreground">
        {children}
      </div>
    </section>
  );
}
