import { createFileRoute } from "@tanstack/react-router";
import { DocsLayout, DocsSection, Callout } from "@/components/DocsLayout";
import { useI18n } from "@/i18n";

export const Route = createFileRoute("/roadmap")({
  head: () => ({
    meta: [
      { title: "Hoja de Ruta — Nyrava México" },
      { name: "description", content: "Evolución y próximos desarrollos del sistema operativo de inteligencia jurídica Nyrava México." },
      { property: "og:url", content: "https://mexico.nyrava.com/roadmap" },
      { name: "twitter:url", content: "https://mexico.nyrava.com/roadmap" },
      { property: "og:title", content: "Hoja de Ruta — Nyrava México" },
      { property: "og:description", content: "Hoja de ruta pública de Nyrava Inteligencia Jurídica México." },
      { property: "og:type", content: "article" },
    ],
    links: [{ rel: "canonical", href: "https://mexico.nyrava.com/roadmap" }],
  }),
  component: RoadmapPage,
});

function RoadmapPage() {
  const { t, tList } = useI18n();

  const section = (id: string, headingKey: string, listKey: string) => (
    <DocsSection id={id} heading={t(headingKey)}>
      <ul className="list-disc space-y-1 pl-5">
        {tList(listKey).map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </DocsSection>
  );

  return (
    <DocsLayout
      eyebrow={t("roadmap.eyebrow")}
      title={t("roadmap.title")}
      description={t("roadmap.description")}
      crumbs={[{ label: t("roadmap.eyebrow") }, { label: t("roadmap.title") }]}
      toc={[
        { id: "shipped", label: t("roadmap.toc.shipped") },
        { id: "now", label: t("roadmap.toc.now") },
        { id: "next", label: t("roadmap.toc.next") },
        { id: "later", label: t("roadmap.toc.later") },
      ]}
    >
      <Callout variant="info" title={t("roadmap.policy.title")}>
        {t("roadmap.policy.body")}
      </Callout>

      {section("shipped", "roadmap.toc.shipped", "roadmap.shipped.items")}
      {section("now", "roadmap.toc.now", "roadmap.now.items")}
      {section("next", "roadmap.toc.next", "roadmap.next.items")}
      {section("later", "roadmap.toc.later", "roadmap.later.items")}
    </DocsLayout>
  );
}
