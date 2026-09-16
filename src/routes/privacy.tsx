import { createFileRoute } from "@tanstack/react-router";
import { LegalPage, Section } from "@/components/LegalPage";
import { useI18n } from "@/i18n";
import {
  PRIVACY_NOTICE_ES,
  PRIVACY_NOTICE_EN,
  PRIVACY_VERSION,
  PRIVACY_EFFECTIVE_DATE,
  PRIVACY_NOTICE_HASH,
} from "@/lib/legal/privacy-notice";

export const Route = createFileRoute("/privacy")({
  head: () => ({
    meta: [
      { title: "Aviso de Privacidad — Nyrava México" },
      {
        name: "description",
        content:
          "Aviso de Privacidad Integral de Nyrava México conforme a la LFPDPPP: datos tratados, finalidades, IA, transferencias y derechos ARCO.",
      },
      { property: "og:title", content: "Aviso de Privacidad — Nyrava México" },
      {
        property: "og:description",
        content:
          "Aviso de Privacidad Integral de Nyrava México conforme a la LFPDPPP: datos tratados, finalidades, IA, transferencias y derechos ARCO.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
      { property: "og:url", content: "https://mexico.nyrava.com/privacy" },
      { name: "twitter:url", content: "https://mexico.nyrava.com/privacy" },
      { name: "robots", content: "index,follow" },
    ],
    links: [{ rel: "canonical", href: "https://mexico.nyrava.com/privacy" }],
  }),
  component: PrivacyPage,
});

function PrivacyPage() {
  const { t, locale } = useI18n();
  const notice = locale === "en" ? PRIVACY_NOTICE_EN : PRIVACY_NOTICE_ES;
  const es = locale !== "en";

  return (
    <LegalPage
      eyebrow={t("footer.section.legal")}
      title={notice.title}
      updated={
        es
          ? `Versión ${PRIVACY_VERSION} · Vigente desde ${PRIVACY_EFFECTIVE_DATE}`
          : `Version ${PRIVACY_VERSION} · Effective ${PRIVACY_EFFECTIVE_DATE}`
      }
      intro={<p>{notice.intro}</p>}
    >
      {notice.sections.map((section) => (
        <Section key={section.heading} heading={section.heading}>
          {section.body.map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
          {section.bullets && (
            <ul className="list-disc space-y-1 pl-5">
              {section.bullets.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          )}
        </Section>
      ))}

      <Section heading={es ? "Documentos relacionados" : "Related documents"}>
        <p>
          <a href="/ai-transparency" className="text-primary hover:underline">
            {es ? "Transparencia de IA" : "AI Transparency"}
          </a>
          {" · "}
          <a href="/security" className="text-primary hover:underline">
            {es ? "Seguridad" : "Security"}
          </a>
          {" · "}
          <a href="/data-control" className="text-primary hover:underline">
            {es ? "Control de datos y derechos ARCO" : "Data control and ARCO rights"}
          </a>
          {" · "}
          <a href="/contact" className="text-primary hover:underline">
            {es ? "Contacto" : "Contact"}
          </a>
        </p>
        <p className="font-mono text-xs text-muted-foreground">
          SHA-256: {PRIVACY_NOTICE_HASH}
        </p>
      </Section>
    </LegalPage>
  );
}
