import { createFileRoute, Link } from "@tanstack/react-router";
import { DocsLayout, DocsSection, FAQ, breadcrumbJsonLd, CANONICAL_BASE } from "@/components/DocsLayout";
import { Rocket, BookOpen, ShieldCheck, User, LifeBuoy, KeyRound } from "lucide-react";

const FAQ_ITEMS = [
  {
    q: "What is Nyrava Intelligence OS?",
    a: "Nyrava Intelligence OS is a Legal Intelligence Operating System that helps attorneys and investigators analyze evidence, build timelines, assess witnesses, and draft motions.",
  },
  {
    q: "How do I run my first case?",
    a: "Sign in, create a new case, upload your documents, and launch the analysis pipeline. The Learning Center walks through each step.",
  },
  {
    q: "Can I use my own AI provider keys?",
    a: "Yes. Go to Settings → API Keys and add keys for OpenAI, Anthropic, Gemini, Groq, or OpenRouter. Provider costs are billed directly to your account with that provider.",
  },
  {
    q: "Is my data secure?",
    a: "Nyrava is built on a SOC 2 Type II compliant architecture with AES-256-GCM encryption, workspace isolation, and attorney-work-product protections.",
  },
];

function faqJsonLd(base: string, items: { q: string; a: string }[]) {
  return JSON.stringify({
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((it) => ({
      "@type": "Question",
      name: it.q,
      acceptedAnswer: {
        "@type": "Answer",
        text: it.a,
      },
    })),
  });
}

export const Route = createFileRoute("/help/")({
  head: () => {
    const url = `${CANONICAL_BASE}/help`;
    const desc = "Nyrava Help Center — getting started, case intelligence, attorney work product, security, and account management.";
    return {
      meta: [
        { title: "Help Center — Nyrava Intelligence OS" },
        { name: "description", content: desc },
        { property: "og:title", content: "Help Center — Nyrava" },
        { property: "og:description", content: desc },
        { property: "og:type", content: "website" },
        { property: "og:url", content: url },
        { name: "twitter:card", content: "summary_large_image" },
      ],
      links: [{ rel: "canonical", href: url }],
      scripts: [
        {
          type: "application/ld+json",
          children: breadcrumbJsonLd(CANONICAL_BASE, [{ label: "Help Center", to: "/help" }]),
        },
        {
          type: "application/ld+json",
          children: faqJsonLd(CANONICAL_BASE, FAQ_ITEMS),
        },
      ],
    };
  },
  component: HelpCenter,
});

const CATEGORIES = [
  {
    icon: Rocket,
    heading: "Getting Started",
    articles: [
      { to: "/learning-center", label: "Learning Center — full setup & training guide" },
      { to: "/help/first-case", label: "Running your first case" },
      { to: "/help/uploading", label: "Uploading documents & supported file types" },
      { to: "/help/api-keys", label: "API keys & bring-your-own providers" },
      { to: "/help/reports", label: "Understanding reports & the 17 sections" },
    ],
  },
  {
    icon: BookOpen,
    heading: "Case Intelligence",
    articles: [
      { to: "/product/evidence-intelligence", label: "Evidence Intelligence" },
      { to: "/product/timeline-intelligence", label: "Timeline Intelligence" },
      { to: "/product/witness-intelligence", label: "Witness Intelligence" },
      { to: "/product/constitutional-intelligence", label: "Constitutional Intelligence" },
      { to: "/product/motion-intelligence", label: "Motion Intelligence" },
      { to: "/product/report-intelligence", label: "Report Intelligence" },
    ],
  },
  {
    icon: KeyRound,
    heading: "Attorney Work Product",
    articles: [
      { to: "/product/motion-intelligence", label: "Generated motions" },
      { to: "/product/report-intelligence", label: "Draft reports" },
      { to: "/ai-transparency", label: "Source citations & verification" },
      { to: "/responsible-ai", label: "Attorney verification requirements" },
    ],
  },
  {
    icon: ShieldCheck,
    heading: "Security & Privacy",
    articles: [
      { to: "/trust", label: "Trust Center" },
      { to: "/security", label: "Security practices" },
      { to: "/data-control", label: "Data isolation & control" },
      { to: "/privacy", label: "Privacy policy" },
      { to: "/ai-transparency", label: "AI transparency" },
      { to: "/responsible-ai", label: "Responsible AI" },
    ],
  },
  {
    icon: User,
    heading: "Account & Billing",
    articles: [
      { to: "/help/api-keys", label: "API providers" },
      { to: "/beta-terms", label: "Beta program terms" },
      { to: "/data-control", label: "Workspace settings & data export" },
      { to: "/contact", label: "Getting support" },
    ],
  },
  {
    icon: LifeBuoy,
    heading: "Company & Resources",
    articles: [
      { to: "/release-notes", label: "Release notes" },
      { to: "/roadmap", label: "Product roadmap" },
      { to: "/resources", label: "Sample reports & practice-area library" },
      { to: "/about", label: "About Nyrava" },
    ],
  },
];

function HelpCenter() {
  return (
    <DocsLayout
      eyebrow="Support"
      title="Nyrava Help Center"
      description="Browse by category, or press ⌘K to search across every article, policy, and product page."
      crumbs={[{ label: "Help Center", to: "/help" }]}
    >
      <DocsSection heading="Browse by category">
        <div className="my-6 grid gap-4 sm:grid-cols-2">
          {CATEGORIES.map(({ icon: Icon, heading, articles }) => (
            <div key={heading} className="rounded-xl border border-border/60 bg-card/30 p-5">
              <div className="flex items-center gap-2">
                <div className="grid h-8 w-8 place-items-center rounded-md border border-border bg-card/70 text-primary">
                  <Icon className="h-4 w-4" />
                </div>
                <div className="text-[14px] font-semibold text-foreground">{heading}</div>
              </div>
              <ul className="mt-4 space-y-1.5 text-[13px]">
                {articles.map((a) => (
                  <li key={a.to}>
                    <Link to={a.to} className="text-muted-foreground hover:text-foreground">
                      → {a.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </DocsSection>

      <DocsSection id="faq" heading="Frequently asked questions">
        <FAQ items={FAQ_ITEMS} />
      </DocsSection>

      <DocsSection heading="Still need help?">
        <p>
          If you can't find what you're looking for, reach out through the{" "}
          <Link to="/contact" className="text-primary hover:underline">Contact</Link> page. For
          security issues, see the disclosure guidance in the{" "}
          <Link to="/trust" className="text-primary hover:underline">Trust Center</Link>.
        </p>
      </DocsSection>
    </DocsLayout>
  );
}
