import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import {
  Play,
  ArrowRight,
  Scale,
  Landmark,
  ShieldCheck,
  Lock,
  Sparkles,
  ClipboardList,
  Activity,
  HeartHandshake,
  Network,
} from "lucide-react";
import { NyravaLogo } from "@/components/NyravaLogo";
import { HeroOSDashboard } from "@/components/HeroOSDashboard";
import { TrustStrip } from "@/components/TrustStrip";
import { SiteFooter } from "@/components/SiteFooter";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { MobileNav } from "@/components/MobileNav";
import { useI18n } from "@/i18n";
import { listPublishedDemoCases } from "@/lib/demo-cases.functions";

const SITE_URL = "https://mexico.nyrava.com";
const LOGO_URL = `${SITE_URL}/nyrava-shield.png`;
const SOCIAL_IMAGE_URL = `${SITE_URL}/__l5e/assets-v1/775b6578-f629-470f-8bb7-bb39be2faf3c/nyrava-mexico-social-2026.png`;
const SOCIAL_DESCRIPTION = "Inteligencia jurídica más allá del análisis humano.";

const ORGANIZATION_JSON_LD = JSON.stringify({
  "@context": "https://schema.org",
  "@type": "Organization",
  name: "Nyrava",
  url: SITE_URL,
  logo: LOGO_URL,
  description:
    "El sistema operativo de inteligencia jurídica más avanzado. Diseñado para abogados, investigadores y organizaciones que exigen precisión, rigor y resultados.",
});

const WEBSITE_JSON_LD = JSON.stringify({
  "@context": "https://schema.org",
  "@type": "WebSite",
  name: "Nyrava México — Inteligencia Jurídica",
  url: SITE_URL,
  description: "Inteligencia jurídica más allá del análisis humano.",
  publisher: {
    "@type": "Organization",
    name: "Nyrava",
    url: SITE_URL,
    logo: LOGO_URL,
  },
});

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Nyrava México — Inteligencia Jurídica" },
      { property: "og:url", content: `${SITE_URL}/` },
      { name: "twitter:url", content: `${SITE_URL}/` },
      {
        name: "description",
        content:
          "El sistema operativo de inteligencia jurídica más avanzado. Diseñado para abogados, investigadores y organizaciones que exigen precisión, rigor y resultados.",
      },
      { property: "og:title", content: "Nyrava México — Inteligencia Jurídica" },
      {
        property: "og:description",
        content: SOCIAL_DESCRIPTION,
      },
      { property: "og:type", content: "website" },
      { property: "og:image", content: SOCIAL_IMAGE_URL },
      { property: "og:image:secure_url", content: SOCIAL_IMAGE_URL },
      { property: "og:image:type", content: "image/png" },
      { property: "og:image:width", content: "1200" },
      { property: "og:image:height", content: "630" },
      { property: "og:image:alt", content: "Nyrava México — Inteligencia Jurídica Avanzada" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: "Nyrava México — Inteligencia Jurídica" },
      { name: "twitter:description", content: SOCIAL_DESCRIPTION },
      { name: "twitter:image", content: SOCIAL_IMAGE_URL },
      { name: "twitter:image:alt", content: "Nyrava México — Inteligencia Jurídica Avanzada" },
    ],
    links: [{ rel: "canonical", href: `${SITE_URL}/` }],
    scripts: [

      { type: "application/ld+json", children: ORGANIZATION_JSON_LD },
      { type: "application/ld+json", children: WEBSITE_JSON_LD },
    ],
  }),
  beforeLoad: async ({ location }) => {
    if (location.pathname.startsWith("/lovable/")) return;
    if (typeof window === "undefined") return;
    const { data } = await supabase.auth.getSession();
    if (data.session) throw redirect({ to: "/cases" });
  },
  component: Landing,
});

const NAV = [
  { key: "home.nav.product", href: "#product" },
  { key: "home.nav.care", href: "/product/comprehensive-care" },
  { key: "home.nav.about", to: "/about" },
  { key: "home.nav.legalSources", to: "/modules" },
  { key: "home.nav.security", to: "/security" },
  { key: "home.nav.transparency", to: "/ai-transparency" },
  { key: "home.nav.help", to: "/help" },
] as const;

function Landing() {
  const { t } = useI18n();
  const [signedIn, setSignedIn] = useState(false);
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSignedIn(Boolean(data.session)));
  }, []);

  const fetchDemoCases = useServerFn(listPublishedDemoCases);
  const { data: demoCases, isLoading: demosLoading } = useQuery({
    queryKey: ["published-demo-cases"],
    queryFn: () => fetchDemoCases(),
  });

  return (
    <div className="min-h-screen text-foreground">
      {/* Top nav — soft white bar, matches the reference design */}
      <header className="border-b border-border bg-cream text-cream-foreground">
        <div className="mx-auto grid max-w-[100rem] grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 sm:px-6 xl:flex xl:justify-between">
          <div className="flex min-w-0 items-center gap-2 sm:gap-3">
            <NyravaLogo size={48} glow={false} className="shrink-0" />
            <div className="min-w-0 leading-none">
              <span className="block truncate font-display text-lg font-bold tracking-wide sm:text-2xl">NYRAVA MÉXICO</span>
              <span className="mt-1 hidden truncate text-[11px] font-semibold tracking-[0.24em] text-cream-foreground/60 sm:block">
                {t("home.brand.subtitle")}
              </span>
            </div>
          </div>
          <nav className="hidden items-center gap-5 xl:flex 2xl:gap-7">
            {NAV.map((n) =>
              "to" in n ? (
                <Link
                  key={n.key}
                  to={n.to}
                  className="text-[11px] font-semibold tracking-[0.16em] text-cream-foreground/80 transition hover:text-cream-foreground"
                >
                  {t(n.key).toUpperCase()}
                </Link>
              ) : (
                <a
                  key={n.key}
                  href={n.href}
                  className="text-[11px] font-semibold tracking-[0.16em] text-cream-foreground/80 transition hover:text-cream-foreground"
                >
                  {t(n.key).toUpperCase()}
                </a>
              ),
            )}
          </nav>
          <div className="flex shrink-0 items-center justify-end gap-2 sm:gap-3">
            <div className="hidden xl:block"><LanguageSwitcher className="border-border text-cream-foreground" /></div>
            <Link
              to="/auth"
              className="hidden items-center rounded-md border border-border px-3 py-2 text-[11px] font-semibold tracking-[0.14em] text-cream-foreground hover:bg-primary/5 xl:inline-flex"
            >
              {t("nav.signIn")}
            </Link>
            <Link
              to="/auth"
              className="hidden rounded-md px-3 py-2 text-[11px] font-bold tracking-[0.12em] text-primary-foreground shadow-sm transition hover:brightness-105 xl:inline-flex"
              style={{ background: "var(--gradient-primary)" }}
            >
              {t("nav.openPlatform")}
            </Link>
            <MobileNav
              items={NAV.map((n) =>
                "to" in n
                  ? { label: t(n.key).toUpperCase(), to: n.to }
                  : { label: t(n.key).toUpperCase(), href: n.href },
              )}
              triggerClassName="border-border text-cream-foreground xl:hidden"
            >
              <LanguageSwitcher variant="sidebar" className="w-full justify-start" />
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
            </MobileNav>
          </div>
        </div>
      </header>

      <main>
        {/* Hero — soft lavender surface, violet-to-amber gradient accent */}
        <section className="relative overflow-hidden bg-background">
          <div
            aria-hidden
            className="pointer-events-none absolute -left-24 -top-40 h-[420px] w-[420px] rounded-full opacity-40 blur-[70px]"
            style={{ background: "#A78BFA" }}
          />
          <div
            aria-hidden
            className="pointer-events-none absolute -bottom-40 left-1/3 h-[360px] w-[360px] rounded-full opacity-35 blur-[70px]"
            style={{ background: "#FBBE85" }}
          />
          <div className="relative mx-auto max-w-[100rem] px-4 py-12 sm:px-6 sm:py-14 lg:py-20">
            <div className="grid gap-10 lg:grid-cols-[0.85fr_1.15fr] lg:items-center">
              {/* Left: headline + CTAs */}
              <div className="min-w-0">
                <div className="mb-3 flex items-center gap-2 text-[11px] font-semibold tracking-[0.24em] text-primary">
                  <Scale className="h-3.5 w-3.5" /> {t("home.hero.tagline")}
                </div>
                <h1 className="break-words font-display text-4xl font-extrabold not-italic leading-[1.05] tracking-normal text-foreground sm:text-5xl md:text-[64px]">
                  {t("home.hero.line1")}
                  <br />
                  <span className="text-gradient-primary">{t("home.hero.line2")}</span>
                </h1>
                <p className="mt-8 max-w-[560px] text-[19px] leading-relaxed text-muted-foreground">
                  {t("home.hero.subtitle")}
                </p>
                <div className="mt-10 flex min-w-0 flex-col gap-3 sm:flex-row sm:flex-wrap">
                  <Link
                    to="/auth"
                    className="inline-flex min-w-0 items-center justify-center gap-2 rounded-[14px] px-5 py-5 text-center text-[11px] font-bold tracking-[0.14em] text-primary-foreground shadow-lg transition hover:-translate-y-0.5 sm:h-[58px] sm:px-6 sm:py-0"
                    style={{ background: "var(--gradient-primary)", boxShadow: "0 14px 30px -10px rgba(124,58,237,0.5)" }}
                  >
                    {t("home.cta.launchCommand")} <ArrowRight className="h-4 w-4" />
                  </Link>
                  <a
                    href="#product"
                    className="inline-flex min-w-0 items-center justify-center gap-2 rounded-[14px] border border-border bg-card px-5 py-5 text-center text-[11px] font-bold tracking-[0.14em] text-foreground transition hover:-translate-y-0.5 hover:border-primary/50 sm:h-[58px] sm:px-6 sm:py-0"
                  >
                    {t("home.cta.watchDemo")} <Play className="h-3.5 w-3.5" />
                  </a>
                </div>
              </div>

              {/* Right: left-cards / trust badge / right-cards — symmetric grid, responsive built in */}
              <HeroOSDashboard />
            </div>
          </div>
        </section>

        {/* Cream feature strip */}
        <section className="border-y border-border bg-cream text-cream-foreground">
          <div className="mx-auto grid max-w-[100rem] grid-cols-2 gap-6 px-6 py-8 md:grid-cols-4">
            {[
              {
                icon: ShieldCheck,
                titleKey: "home.features.sources.title",
                subKey: "home.features.sources.subtitle",
              },
              {
                icon: Landmark,
                titleKey: "home.features.laws.title",
                subKey: "home.features.laws.subtitle",
              },
              {
                icon: Lock,
                titleKey: "home.features.security.title",
                subKey: "home.features.security.subtitle",
              },
              {
                icon: Sparkles,
                titleKey: "home.features.forLawyers.title",
                subKey: "home.features.forLawyers.subtitle",
              },
            ].map((it) => (
              <div key={it.titleKey} className="flex items-start gap-3">
                <it.icon
                  className="mt-0.5 h-5 w-5 shrink-0 text-cream-foreground"
                  strokeWidth={1.5}
                />
                <div>
                  <div className="text-[11px] font-bold leading-tight tracking-[0.02em]">
                    {t(it.titleKey)}
                  </div>
                  <div className="mt-1 text-[11px] text-cream-foreground/70">{t(it.subKey)}</div>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Legal & Data Protection Disclaimers */}
        <section className="border-b border-border bg-secondary/30 text-foreground">
          <div className="mx-auto flex max-w-[100rem] flex-col gap-2 px-6 py-4 text-[11px] text-muted-foreground md:flex-row md:items-center md:justify-between">
            <span className="flex items-center gap-2">
              <Scale className="h-3.5 w-3.5 text-primary" /> {t("home.disclaimer.criterion")}
            </span>
            <span className="flex items-center gap-2">
              <Lock className="h-3.5 w-3.5 text-primary" /> {t("home.disclaimer.dataLaw")}
            </span>
          </div>
        </section>

        {/* Comprehensive Care — the platform's second operational core */}
        <section className="border-b border-border bg-card/30">
          <div className="mx-auto max-w-[100rem] px-6 py-14 lg:py-18">
            <div className="grid gap-10 lg:grid-cols-[0.78fr_1.22fr] lg:items-center">
              <div>
                <div className="text-[11px] font-semibold tracking-[0.28em] text-primary">
                  {t("home.care.eyebrow")}
                </div>
                <h2 className="mt-3 font-display text-3xl font-semibold leading-tight md:text-4xl">
                  {t("home.care.title")}
                </h2>
                <p className="mt-5 max-w-xl text-[15px] leading-relaxed text-muted-foreground">
                  {t("home.care.description")}
                </p>
                <Link
                  to="/product/$slug"
                  params={{ slug: "comprehensive-care" }}
                  className="mt-7 inline-flex items-center gap-2 rounded-lg bg-primary px-5 py-3 text-[11px] font-bold tracking-[0.14em] text-primary-foreground transition hover:brightness-110"
                >
                  {t("home.care.cta")} <ArrowRight className="h-4 w-4" />
                </Link>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                {[
                  { icon: ClipboardList, title: "home.care.intake.title", description: "home.care.intake.description" },
                  { icon: Activity, title: "home.care.risk.title", description: "home.care.risk.description" },
                  { icon: HeartHandshake, title: "home.care.plans.title", description: "home.care.plans.description" },
                  { icon: Network, title: "home.care.referrals.title", description: "home.care.referrals.description" },
                ].map(({ icon: Icon, title, description }) => (
                  <div key={title} className="rounded-xl border border-border/60 bg-background/70 p-5">
                    <Icon className="h-5 w-5 text-primary" strokeWidth={1.6} />
                    <h3 className="mt-4 text-[14px] font-semibold text-foreground">{t(title)}</h3>
                    <p className="mt-2 text-[12.5px] leading-relaxed text-muted-foreground">{t(description)}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* Experience Nyrava — live case demos */}
        <section id="product" className="mx-auto max-w-[100rem] px-6 py-12 lg:py-16">
          <div className="mb-3 text-[11px] font-semibold tracking-[0.28em] tag-bracket text-primary">
            {t("home.demos.tag")}
          </div>
          <h2 className="mb-8 max-w-2xl font-display text-2xl font-semibold leading-tight md:text-3xl">
            {t("home.demos.title")}
          </h2>

          {demosLoading && (
            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="panel h-40 animate-pulse" />
              ))}
            </div>
          )}

          {!demosLoading && (!demoCases || demoCases.length === 0) && (
            <div className="panel p-8 text-sm text-muted-foreground">{t("home.demos.empty")}</div>
          )}

          {!demosLoading && demoCases && demoCases.length > 0 && (
            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {demoCases.map((c) => (
                <Link
                  key={c.id}
                  to="/demo/$slug"
                  params={{ slug: c.slug }}
                  className="panel group flex flex-col gap-4 p-5 transition hover:-translate-y-0.5"
                >
                  <div className="grid h-12 w-12 place-items-center rounded-md border border-border bg-card p-1">
                    <NyravaLogo size={32} />
                  </div>

                  <div>
                    <div className="text-[10.5px] font-semibold tracking-[0.2em] text-primary">
                      {c.case_type_label.toUpperCase()}
                    </div>
                    <h3 className="mt-1 font-display text-base font-semibold leading-tight">
                      {c.name}
                    </h3>
                    {c.summary && (
                      <p className="mt-2 text-[12.5px] leading-relaxed text-muted-foreground">
                        {c.summary}
                      </p>
                    )}
                  </div>
                  <span className="mt-auto inline-flex items-center gap-1 text-[10.5px] font-semibold tracking-[0.22em] text-primary transition group-hover:gap-2">
                    {t("home.demos.run")} <ArrowRight className="h-3 w-3" />
                  </span>
                </Link>
              ))}
            </div>
          )}
        </section>

        <TrustStrip />
      </main>
      <SiteFooter />
    </div>
  );
}
