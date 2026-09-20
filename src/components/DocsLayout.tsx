import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronRight, ArrowRight, ArrowUp, Info, ShieldCheck, AlertTriangle, Lightbulb, ChevronDown, Menu, X } from "lucide-react";
import { NyravaLogo } from "./NyravaLogo";
import { SiteFooter } from "./SiteFooter";
import { DocsSidebar } from "./docs/DocsSidebar";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { useI18n } from "@/i18n";

export type Crumb = { label: string; to?: string };
export type TocItem = { id: string; label: string };
export type RelatedItem = { label: string; to: string; description?: string };

type Props = {
  eyebrow?: string;
  title: string;
  description?: string;
  crumbs?: Crumb[];
  toc?: TocItem[];
  updated?: string;
  next?: { label: string; to: string };
  related?: RelatedItem[];
  hideSidebar?: boolean;
  children: ReactNode;
};

export function DocsLayout({
  eyebrow,
  title,
  description,
  crumbs = [],
  toc = [],
  updated,
  next,
  related,
  hideSidebar = false,
  children,
}: Props) {
  const { t } = useI18n();
  const [activeId, setActiveId] = useState<string | null>(toc[0]?.id ?? null);
  const [showTop, setShowTop] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  useEffect(() => {
    if (toc.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActiveId(visible[0].target.id);
      },
      { rootMargin: "-80px 0px -70% 0px", threshold: 0 },
    );
    toc.forEach((t) => {
      const el = document.getElementById(t.id);
      if (el) observer.observe(el);
    });
    return () => observer.disconnect();
  }, [toc]);

  useEffect(() => {
    function onScroll() {
      setShowTop(window.scrollY > 600);
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <div className="min-h-screen text-foreground">
      <header className="sticky top-0 z-40 border-b border-border/60 bg-background/85 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3 md:px-6">
          <div className="flex items-center gap-2">
            {!hideSidebar && (
              <button
                aria-label={t("docsSite.toggleNavigation")}
                onClick={() => setMobileNavOpen((v) => !v)}
                className="rounded-md border border-border/60 p-2 lg:hidden"
              >
                {mobileNavOpen ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
              </button>
            )}
            <Link to="/" className="flex items-center gap-2" aria-label={t("docsSite.nyravaHome")}>
              <NyravaLogo size={28} withWordmark />
            </Link>
            <span className="ml-3 hidden text-[10.5px] font-semibold uppercase tracking-[0.22em] text-muted-foreground md:inline">
              {t("docsSite.docs")}
            </span>
          </div>
          <nav className="flex items-center gap-2">
            <Link to="/trust" className="hidden text-[12px] font-medium text-muted-foreground hover:text-foreground md:inline">{t("docsSite.trustCenter")}</Link>
            <Link to="/help" className="hidden text-[12px] font-medium text-muted-foreground hover:text-foreground md:inline">{t("docsSite.help")}</Link>
            <LanguageSwitcher variant="header" />
            <Link
              to="/auth"
              className="rounded-md border border-border bg-card/60 px-4 py-2 text-[11px] font-semibold tracking-[0.16em] text-foreground hover:bg-card"
            >
              {t("nav.signIn")}
            </Link>
          </nav>
        </div>
      </header>

      {crumbs.length > 0 && (
        <div className="border-b border-border/40">
          <div className="mx-auto max-w-7xl px-4 py-3 md:px-6">
            <nav aria-label={t("docsSite.breadcrumb")} className="flex flex-wrap items-center gap-1.5 text-[12px] text-muted-foreground">
              <Link to="/" className="hover:text-foreground">{t("docsSite.home")}</Link>
              {crumbs.map((c, i) => (
                <span key={i} className="flex items-center gap-1.5">
                  <ChevronRight className="h-3 w-3 opacity-50" />
                  {c.to ? (
                    <Link to={c.to} className="hover:text-foreground">{c.label}</Link>
                  ) : (
                    <span className="text-foreground/90">{c.label}</span>
                  )}
                </span>
              ))}
            </nav>
          </div>
        </div>
      )}

      <div className="mx-auto max-w-7xl px-4 py-8 md:px-6 md:py-12">
        <div
          className={
            hideSidebar
              ? "grid gap-10 lg:grid-cols-[minmax(0,1fr)_240px]"
              : "grid gap-8 lg:grid-cols-[220px_minmax(0,1fr)_220px]"
          }
        >
          {!hideSidebar && (
            <div className={`${mobileNavOpen ? "block" : "hidden"} lg:block`}>
              <DocsSidebar />
            </div>
          )}

          <main className="min-w-0">
            <article className="min-w-0">
              <div className="mb-8">
                {eyebrow && (
                  <div className="mb-3 text-[10.5px] font-semibold uppercase tracking-[0.28em] text-primary">
                    {eyebrow}
                  </div>
                )}
                <h1 className="font-display text-3xl font-semibold leading-tight md:text-4xl">{title}</h1>
                {description && (
                  <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-muted-foreground">
                    {description}
                  </p>
                )}
                {updated && (
                  <div className="mt-4 text-[11px] uppercase tracking-[0.18em] text-muted-foreground/80">
                    {t("docsSite.lastUpdated")} {updated}
                  </div>
                )}
              </div>

              <div className="docs-prose space-y-10">{children}</div>

              {next && (
                <div className="mt-16 border-t border-border/60 pt-6">
                  <Link
                    to={next.to}
                    className="group flex items-center justify-between rounded-lg border border-border/60 bg-card/40 px-5 py-4 hover:border-primary/40 hover:bg-card/70"
                  >
                    <div>
                      <div className="text-[10.5px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">{t("docsSite.next")}</div>
                      <div className="mt-1 text-[15px] font-semibold text-foreground">{next.label}</div>
                    </div>
                    <ArrowRight className="h-4 w-4 text-primary transition-transform group-hover:translate-x-0.5" />
                  </Link>
                </div>
              )}

              {related && related.length > 0 && (
                <div className="mt-12">
                  <div className="mb-4 text-[10.5px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
                    {t("docsSite.relatedDocumentation")}
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {related.map((r) => (
                      <Link
                        key={r.to}
                        to={r.to}
                        className="rounded-lg border border-border/60 bg-card/30 p-4 hover:border-primary/40 hover:bg-card/60"
                      >
                        <div className="text-[13.5px] font-semibold text-foreground">{r.label}</div>
                        {r.description && (
                          <div className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
                            {r.description}
                          </div>
                        )}
                      </Link>
                    ))}
                  </div>
                </div>
              )}
            </article>
          </main>

          {toc.length > 0 && (
            <aside className="hidden lg:block">
              <div className="sticky top-24">
                <div className="text-[10.5px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
                  {t("docsSite.onThisPage")}
                </div>
                <ul className="mt-3 space-y-1.5 border-l border-border/60 text-[12.5px]">
                  {toc.map((t) => (
                    <li key={t.id}>
                      <a
                        href={`#${t.id}`}
                        className={`block border-l-2 pl-3 py-1 -ml-px transition-colors ${
                          activeId === t.id
                            ? "border-primary text-foreground"
                            : "border-transparent text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        {t.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            </aside>
          )}
        </div>
      </div>

      {showTop && (
        <button
          onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
          className="fixed bottom-6 right-6 z-40 grid h-10 w-10 place-items-center rounded-full border border-border bg-card/90 text-muted-foreground shadow-lg backdrop-blur hover:text-foreground"
          aria-label={t("docsSite.backToTop")}
        >
          <ArrowUp className="h-4 w-4" />
        </button>
      )}

      <SiteFooter />
    </div>
  );
}

export function DocsSection({
  id,
  heading,
  children,
}: {
  id?: string;
  heading?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-24">
      {heading && (
        <h2 className="font-display text-xl font-semibold text-foreground md:text-2xl">{heading}</h2>
      )}
      <div className="mt-4 space-y-4 text-[14px] leading-relaxed text-muted-foreground">{children}</div>
    </section>
  );
}

export function Callout({
  variant = "info",
  title,
  children,
}: {
  variant?: "info" | "success" | "warning" | "tip";
  title?: string;
  children: ReactNode;
}) {
  const map = {
    info: { Icon: Info, tone: "border-primary/30 bg-primary/5 text-primary" },
    success: { Icon: ShieldCheck, tone: "border-emerald-500/30 bg-emerald-500/5 text-emerald-400" },
    warning: { Icon: AlertTriangle, tone: "border-amber-500/30 bg-amber-500/5 text-amber-400" },
    tip: { Icon: Lightbulb, tone: "border-primary/30 bg-primary/5 text-primary" },
  } as const;
  const { Icon, tone } = map[variant];
  return (
    <div className={`my-4 flex gap-3 rounded-lg border p-4 ${tone}`}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0 text-[13.5px] leading-relaxed text-foreground/90">
        {title && <div className="mb-1 font-semibold text-foreground">{title}</div>}
        <div className="space-y-2">{children}</div>
      </div>
    </div>
  );
}

export function FeatureGrid({
  items,
}: {
  items: { icon?: ReactNode; title: string; description: string }[];
}) {
  return (
    <div className="my-6 grid gap-3 sm:grid-cols-2">
      {items.map((it) => (
        <div key={it.title} className="rounded-lg border border-border/60 bg-card/30 p-4">
          {it.icon && <div className="mb-3 text-primary">{it.icon}</div>}
          <div className="text-[13.5px] font-semibold text-foreground">{it.title}</div>
          {it.description && (
            <div className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">{it.description}</div>
          )}
        </div>
      ))}
    </div>
  );
}

export function StepList({ steps }: { steps: { title: string; description: string }[] }) {
  return (
    <ol className="my-6 space-y-4">
      {steps.map((s, i) => (
        <li key={s.title + i} className="flex gap-4 rounded-lg border border-border/60 bg-card/30 p-4">
          <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-primary/40 bg-primary/10 text-[13px] font-semibold text-primary">
            {i + 1}
          </div>
          <div className="min-w-0">
            <div className="text-[14px] font-semibold text-foreground">{s.title}</div>
            <div className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{s.description}</div>
          </div>
        </li>
      ))}
    </ol>
  );
}

export function FAQ({ items }: { items: { q: string; a: ReactNode }[] }) {
  return (
    <div className="my-6 divide-y divide-border/60 rounded-lg border border-border/60 bg-card/20">
      {items.map((it, i) => (
        <FAQItem key={i} q={it.q} a={it.a} />
      ))}
    </div>
  );
}

function FAQItem({ q, a }: { q: string; a: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left"
        aria-expanded={open}
      >
        <span className="text-[14px] font-medium text-foreground">{q}</span>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <div className="px-5 pb-5 text-[13px] leading-relaxed text-muted-foreground">{a}</div>
      )}
    </div>
  );
}

/**
 * Build BreadcrumbList JSON-LD for a docs page.
 * Consumed inside `head()` scripts array.
 */
export function breadcrumbJsonLd(base: string, crumbs: Crumb[]) {
  const items = [
    { name: "Home", to: "/" },
    ...crumbs.map((c) => ({ name: c.label, to: c.to })),
  ];
  return JSON.stringify({
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((it, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: it.name,
      item: it.to ? `${base}${it.to}` : undefined,
    })),
  });
}

/**
 * Build canonical Product JSON-LD for Nyrava software module pages.
 * Consumed inside `head()` scripts array.
 */
export function productJsonLd(
  base: string,
  product: {
    slug: string;
    title: string;
    description: string;
    category?: string;
    image?: string;
    sku?: string;
    offers?: {
      price: string;
      priceCurrency: string;
      availability?: string;
    };
  },
) {
  const entity: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: product.title,
    description: product.description,
    url: `${base}/product/${product.slug}`,
    brand: {
      "@type": "Brand",
      name: "Nyrava",
    },
    category: product.category || "Legal Technology Software",
  };

  if (product.image) {
    entity.image = product.image;
  }

  if (product.sku) {
    entity.sku = product.sku;
  }

  if (product.offers) {
    entity.offers = {
      "@type": "Offer",
      url: `${base}/product/${product.slug}`,
      priceCurrency: product.offers.priceCurrency,
      price: product.offers.price,
      availability: product.offers.availability || "https://schema.org/InStock",
    };
  }

  return JSON.stringify(entity);
}

export const CANONICAL_BASE = "https://mexico.nyrava.com";
