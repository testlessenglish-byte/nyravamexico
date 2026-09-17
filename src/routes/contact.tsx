import { createFileRoute } from "@tanstack/react-router";
import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";
import { Mail, MapPin } from "lucide-react";
import { useI18n } from "@/i18n";

export const Route = createFileRoute("/contact")({
  head: () => ({
    meta: [
      { title: "Contacto · Nyrava Intelligence México" },
      { name: "description", content: "Contacta al equipo de Nyrava Intelligence México — programa cerrado para despachos e instituciones legales." },
      { property: "og:title", content: "Contacto · Nyrava México" },
      { property: "og:description", content: "Programa cerrado para despachos e instituciones legales en México." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [{ rel: "canonical", href: "https://mexico.nyrava.com/contact" }],
  }),
  component: ContactPage,
});

function ContactPage() {
  const { t } = useI18n();
  return (
    <div className="min-h-screen">
      <SiteHeader />
      <section className="mx-auto max-w-4xl px-6 py-20">
        <span className="tag-bracket font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
          {t("contact.tag")}
        </span>
        <h1 className="mt-3 font-display text-4xl font-bold leading-tight md:text-5xl">
          {t("contact.title.line1")} <span className="font-editorial text-primary">{t("contact.title.line2")}</span>
        </h1>
        <p className="mt-6 max-w-2xl text-muted-foreground">{t("contact.body")}</p>

        <div className="mt-12 grid gap-4 md:grid-cols-2">
          <div className="panel p-6">
            <Mail className="h-5 w-5 text-primary" />
            <h3 className="mt-3 font-display text-base font-semibold">{t("contact.email")}</h3>
            <p className="mt-1 text-sm text-muted-foreground">contact@mexico.nyrava.com</p>
          </div>
          <div className="panel p-6">
            <MapPin className="h-5 w-5 text-primary" />
            <h3 className="mt-3 font-display text-base font-semibold">{t("contact.location")}</h3>
            <p className="mt-1 text-sm text-muted-foreground">{t("contact.location.value")}</p>
          </div>
        </div>
      </section>
      <SiteFooter />
    </div>
  );
}
