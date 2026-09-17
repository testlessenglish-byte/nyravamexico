import { createFileRoute, Link } from "@tanstack/react-router";
import {
  DocsLayout,
  DocsSection,
  Callout,
  FeatureGrid,
  breadcrumbJsonLd,
  CANONICAL_BASE,
} from "@/components/DocsLayout";
import { PipelineDiagram } from "@/components/docs/PipelineDiagram";
import { useI18n } from "@/i18n";
import {
  Lock,
  ShieldCheck,
  Eye,
  FileCheck2,
  Sparkles,
  Scale,
  Database,
  UserCheck,
  Server,
  GitBranch,
  ClipboardCheck,
} from "lucide-react";

export const Route = createFileRoute("/trust")({
  head: () => {
    const url = `${CANONICAL_BASE}/trust`;
    const desc =
      "Arquitectura de seguridad, cifrado, aislamiento de datos por despacho, verificación probatoria e IA responsable para expedientes confidenciales en México.";
    return {
      meta: [
        { title: "Centro de Confianza y Seguridad — Nyrava México" },
        { name: "description", content: desc },
        { property: "og:title", content: "Centro de Confianza — Nyrava México" },
        { property: "og:description", content: desc },
        { property: "og:type", content: "website" },
        { property: "og:url", content: url },
        { name: "twitter:card", content: "summary_large_image" },
        { name: "twitter:title", content: "Centro de Confianza — Nyrava México" },
        { name: "twitter:description", content: desc },
      ],
      links: [{ rel: "canonical", href: url }],
      scripts: [
        {
          type: "application/ld+json",
          children: breadcrumbJsonLd(CANONICAL_BASE, [{ label: "Trust Center", to: "/trust" }]),
        },
      ],
    };
  },
  component: TrustCenter,
});

const PILLARS = [
  { to: "/confidentiality", key: "confidentiality", icon: ShieldCheck },
  { to: "/privacy", key: "privacy", icon: Lock },
  { to: "/security", key: "security", icon: ShieldCheck },
  { to: "/ai-transparency", key: "ai", icon: Sparkles },
  { to: "/responsible-ai", key: "responsible", icon: Scale },
  { to: "/data-control", key: "data", icon: Database },
  { to: "/dpa", key: "dpa", icon: FileCheck2 },
  { to: "/acceptable-use", key: "use", icon: UserCheck },
  { to: "/accessibility", key: "accessibility", icon: Eye },
] as const;

const TOC_IDS = ["principles", "architecture", "pipeline", "pillars", "attorney", "evidence", "data", "encryption", "availability", "limits", "compliance", "faq", "contact"] as const;

function TrustCenter() {
  const { t, tList } = useI18n();
  const toc = TOC_IDS.map((id) => ({ id, label: t(`trust.toc.${id}`) }));
  const faqs = Array.from({ length: 6 }, (_, index) => ({
    q: t(`trust.faq.q${index + 1}`),
    a: t(`trust.faq.a${index + 1}`),
  }));

  return (
    <DocsLayout
      eyebrow={t("trust.eyebrow")}
      title={t("trust.title")}
      description={t("trust.description")}
      crumbs={[{ label: t("trust.eyebrow"), to: "/trust" }]}
      toc={toc}
    >
      <DocsSection id="principles" heading={t("trust.toc.principles")}>
        <p>{t("trust.principles.intro")}</p>
        <FeatureGrid items={[
          { icon: <UserCheck className="h-4 w-4" />, title: t("trust.principles.control.title"), description: t("trust.principles.control.description") },
          { icon: <FileCheck2 className="h-4 w-4" />, title: t("trust.principles.evidence.title"), description: t("trust.principles.evidence.description") },
          { icon: <Eye className="h-4 w-4" />, title: t("trust.principles.transparency.title"), description: t("trust.principles.transparency.description") },
          { icon: <Lock className="h-4 w-4" />, title: t("trust.principles.privacy.title"), description: t("trust.principles.privacy.description") },
          { icon: <ShieldCheck className="h-4 w-4" />, title: t("trust.principles.responsible.title"), description: t("trust.principles.responsible.description") },
          { icon: <Sparkles className="h-4 w-4" />, title: t("trust.principles.training.title"), description: t("trust.principles.training.description") },
        ]} />
      </DocsSection>

      <DocsSection id="architecture" heading={t("trust.toc.architecture")}>
        <p>{t("trust.architecture.body")}</p>
        <FeatureGrid items={[
          { icon: <Server className="h-4 w-4" />, title: t("trust.architecture.managed.title"), description: t("trust.architecture.managed.description") },
          { icon: <ShieldCheck className="h-4 w-4" />, title: t("trust.architecture.isolation.title"), description: t("trust.architecture.isolation.description") },
          { icon: <GitBranch className="h-4 w-4" />, title: t("trust.architecture.audit.title"), description: t("trust.architecture.audit.description") },
          { icon: <ClipboardCheck className="h-4 w-4" />, title: t("trust.architecture.roles.title"), description: t("trust.architecture.roles.description") },
        ]} />
      </DocsSection>

      <DocsSection id="pipeline" heading={t("trust.pipeline.heading")}>
        <p>{t("trust.pipeline.body")}</p>
        <PipelineDiagram />
      </DocsSection>

      <DocsSection id="pillars" heading={t("trust.toc.pillars")}>
        <p>{t("trust.pillars.intro")}</p>
        <div className="my-4 grid gap-3 sm:grid-cols-2">
          {PILLARS.map(({ to, key, icon: Icon }) => (
            <Link key={to} to={to} className="group flex gap-3 rounded-lg border border-border/60 bg-card/30 p-4 hover:border-primary/40 hover:bg-card/60">
              <div className="grid h-9 w-9 shrink-0 place-items-center rounded-md border border-border bg-card/70 text-primary"><Icon className="h-4 w-4" /></div>
              <div className="min-w-0">
                <div className="text-[13.5px] font-semibold text-foreground">{t(`trust.pillar.${key}.label`)}</div>
                <div className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">{t(`trust.pillar.${key}.description`)}</div>
              </div>
            </Link>
          ))}
        </div>
      </DocsSection>

      <DocsSection id="attorney" heading={t("trust.toc.attorney")}>
        <p>{t("trust.attorney.body1")}</p><p>{t("trust.attorney.body2")}</p>
      </DocsSection>

      <DocsSection id="evidence" heading={t("trust.evidence.heading")}>
        <p>{t("trust.evidence.body1")}</p><p>{t("trust.evidence.body2")}</p>
        <Callout variant="success" title={t("trust.evidence.callout.title")}>{t("trust.evidence.callout.body")}</Callout>
      </DocsSection>

      <DocsSection id="data" heading={t("trust.toc.data")}>
        <p>{t("trust.data.body1")}</p><p>{t("trust.data.body2")}</p>
        <Callout variant="info" title={t("trust.data.callout.title")}>
          {t("trust.data.callout.before")} <Link to="/confidentiality" className="text-primary hover:underline">{t("trust.data.callout.link")}</Link>. {t("trust.data.callout.after")}
        </Callout>
      </DocsSection>

      <DocsSection id="encryption" heading={t("trust.toc.encryption")}>
        <ul className="list-disc space-y-1 pl-5">{tList("trust.encryption.items").map((item) => <li key={item}>{item}</li>)}</ul>
      </DocsSection>

      <DocsSection id="availability" heading={t("trust.toc.availability")}>
        <p>{t("trust.availability.body1")}</p><p>{t("trust.availability.body2")}</p><p>{t("trust.availability.body3")}</p>
      </DocsSection>

      <DocsSection id="limits" heading={t("trust.toc.limits")}>
        <ul className="list-disc space-y-2 pl-5">{tList("trust.limits.items").map((item) => <li key={item}>{item}</li>)}</ul>
        <Callout variant="warning" title={t("trust.limits.callout.title")}>{t("trust.limits.callout.body")}</Callout>
      </DocsSection>

      <DocsSection id="compliance" heading={t("trust.toc.compliance")}>
        <p>{t("trust.compliance.intro")}</p>
        <ul className="list-disc space-y-1 pl-5">{tList("trust.compliance.verified").map((item) => <li key={item}>{item}</li>)}</ul>
        <p>{t("trust.compliance.roadmap.before")} <Link to="/roadmap" className="text-primary hover:underline">{t("trust.compliance.roadmap.link")}</Link> {t("trust.compliance.roadmap.after")}</p>
        <ul className="list-disc space-y-1 pl-5">{tList("trust.compliance.planned").map((item) => <li key={item}>{item}</li>)}</ul>
        <p>{t("trust.compliance.outro")}</p>
      </DocsSection>

      <DocsSection id="faq" heading={t("trust.toc.faq")}>
        <div className="my-4 grid gap-3 sm:grid-cols-2">
          {faqs.map((faq) => <div key={faq.q} className="rounded-lg border border-border/60 bg-card/30 p-4"><div className="text-[13.5px] font-semibold text-foreground">{faq.q}</div><div className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">{faq.a}</div></div>)}
        </div>
      </DocsSection>

      <DocsSection id="contact" heading={t("trust.toc.contact")}>
        <p>{t("trust.contact.body.before")} <Link to="/contact" className="text-primary hover:underline">{t("trust.contact.link")}</Link>. {t("trust.contact.body.after")}</p>
      </DocsSection>
    </DocsLayout>
  );
}
