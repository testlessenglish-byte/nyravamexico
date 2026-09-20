import { createFileRoute } from "@tanstack/react-router";
import type {} from "@tanstack/react-start";
import { PRODUCTS } from "@/lib/docs/product-copy";

const BASE_URL = "https://mexico.nyrava.com";

interface SitemapEntry {
  path: string;
  changefreq?: "always" | "hourly" | "daily" | "weekly" | "monthly" | "yearly" | "never";
  priority?: string;
}

// Every real static public page. Authenticated app routes (/cases, /admin,
// /motion, etc.) are intentionally excluded — they require login and serve
// nothing to a crawler beyond a redirect to /auth.
const STATIC_ENTRIES: SitemapEntry[] = [
  { path: "/", changefreq: "weekly", priority: "1.0" },
  { path: "/platform", changefreq: "weekly", priority: "0.9" },
  { path: "/modules", changefreq: "weekly", priority: "0.9" },
  { path: "/about", changefreq: "monthly", priority: "0.7" },
  { path: "/how-it-works", changefreq: "monthly", priority: "0.8" },
  { path: "/resources", changefreq: "monthly", priority: "0.6" },
  { path: "/ia-para-abogados", changefreq: "monthly", priority: "0.6" },
  { path: "/learning-center", changefreq: "monthly", priority: "0.6" },
  { path: "/release-notes", changefreq: "weekly", priority: "0.5" },
  { path: "/roadmap", changefreq: "monthly", priority: "0.5" },
  { path: "/security", changefreq: "monthly", priority: "0.7" },
  { path: "/trust", changefreq: "monthly", priority: "0.7" },
  { path: "/confidentiality", changefreq: "monthly", priority: "0.6" },
  { path: "/responsible-ai", changefreq: "monthly", priority: "0.6" },
  { path: "/ai-transparency", changefreq: "monthly", priority: "0.6" },
  { path: "/data-control", changefreq: "monthly", priority: "0.5" },
  { path: "/contact", changefreq: "monthly", priority: "0.6" },
  { path: "/auth", changefreq: "monthly", priority: "0.4" },
  { path: "/help", changefreq: "monthly", priority: "0.6" },
  { path: "/help/first-case", changefreq: "monthly", priority: "0.5" },
  { path: "/help/uploading", changefreq: "monthly", priority: "0.5" },
  { path: "/help/api-keys", changefreq: "monthly", priority: "0.5" },
  { path: "/help/reports", changefreq: "monthly", priority: "0.5" },
  { path: "/privacy", changefreq: "yearly", priority: "0.3" },
  { path: "/terms", changefreq: "yearly", priority: "0.3" },
  { path: "/beta-terms", changefreq: "yearly", priority: "0.3" },
  { path: "/acceptable-use", changefreq: "yearly", priority: "0.3" },
  { path: "/cookies", changefreq: "yearly", priority: "0.3" },
  { path: "/copyright", changefreq: "yearly", priority: "0.3" },
  { path: "/dmca", changefreq: "yearly", priority: "0.3" },
  { path: "/dpa", changefreq: "yearly", priority: "0.3" },
  { path: "/accessibility", changefreq: "yearly", priority: "0.3" },
];

export const Route = createFileRoute("/sitemap.xml")({
  server: {
    handlers: {
      GET: async () => {
        const entries: SitemapEntry[] = [
          ...STATIC_ENTRIES,
          ...PRODUCTS.map((p) => ({
            path: `/product/${p.slug}`,
            changefreq: "monthly" as const,
            priority: "0.8",
          })),
        ];

        // Demo case pages are DB-driven (admin-managed, published flag) —
        // enumerate them the same way listPublishedDemoCases does so the
        // sitemap never drifts from what's actually live.
        try {
          const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
          const { data } = await supabaseAdmin.from("demo_cases").select("slug").eq("published", true);
          for (const row of (data ?? []) as { slug: string }[]) {
            entries.push({ path: `/demo/${row.slug}`, changefreq: "monthly", priority: "0.6" });
          }
        } catch (e) {
          // Never fail the whole sitemap over the dynamic section — the
          // static entries above are still valid and worth serving.
          console.warn("[sitemap] failed to list published demo cases:", e);
        }

        const urls = entries.map((e) =>
          [
            `  <url>`,
            `    <loc>${BASE_URL}${e.path}</loc>`,
            e.changefreq ? `    <changefreq>${e.changefreq}</changefreq>` : null,
            e.priority ? `    <priority>${e.priority}</priority>` : null,
            `  </url>`,
          ].filter(Boolean).join("\n"),
        );

        const xml = [
          `<?xml version="1.0" encoding="UTF-8"?>`,
          `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`,
          ...urls,
          `</urlset>`,
        ].join("\n");

        return new Response(xml, {
          headers: {
            "Content-Type": "application/xml",
            "Cache-Control": "public, max-age=3600",
          },
        });
      },
    },
  },
});
