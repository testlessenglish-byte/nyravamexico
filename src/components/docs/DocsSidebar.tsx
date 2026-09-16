import { Link, useRouterState } from "@tanstack/react-router";
import { DOCS_NAV, DOCS_VERSION } from "@/lib/docs/manifest";
import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import { DocsSearchDialog } from "./DocsSearchDialog";
import { useI18n } from "@/i18n";

const ES_TRANSLATIONS: Record<string, string> = {
  "Getting Started": "Para Empezar",
  "Product": "Producto",
  "Practice Areas": "Áreas de Práctica",
  "Trust & Security": "Confianza y Seguridad",
  "Legal": "Legal",
  "Company": "Compañía",
  "Help Center": "Centro de Ayuda",
  "Learning Center": "Centro de Aprendizaje",
  "How Nyrava Works": "Cómo funciona Nyrava",
  "Running your first case": "Corriendo tu primer caso",
  "Uploading documents": "Subiendo documentos",
  "API keys & providers": "Claves API y proveedores",
  "Understanding reports": "Entendiendo los reportes",
  "Evidence Intelligence": "Evidence Intelligence",
  "Timeline Intelligence": "Timeline Intelligence",
  "Witness Intelligence": "Witness Intelligence",
  "Constitutional Intelligence": "Constitutional Intelligence",
  "Motion Intelligence": "Motion Intelligence",
  "Report Intelligence": "Report Intelligence",
  "Corporate Law Intelligence": "Inteligencia en Derecho Corporativo",
  "Business & Commercial Law Intelligence": "Inteligencia en Derecho Mercantil",
  "Trust Center": "Centro de Confianza",
  "Attorney Confidentiality": "Confidencialidad del Abogado",
  "Security Practices": "Prácticas de Seguridad",
  "AI Transparency": "Transparencia de IA",
  "Responsible AI": "IA Responsable",
  "Data Control": "Control de Datos",
  "Privacy Policy": "Política de Privacidad",
  "Terms of Service": "Términos de Servicio",
  "Acceptable Use Policy": "Política de Uso Aceptable",
  "Data Processing Agreement": "Acuerdo de Procesamiento de Datos",
  "Cookie Policy": "Política de Cookies",
  "DMCA Policy": "Política DMCA",
  "Copyright Policy": "Política de Derechos de Autor",
  "Accessibility Statement": "Declaración de Accesibilidad",
  "Beta Program Terms": "Términos del Programa Beta",
  "About Nyrava": "Acerca de Nyrava",
  "Roadmap": "Hoja de Ruta",
  "Release Notes": "Notas de la Versión",
  "Resources": "Recursos",
  "Contact": "Contacto",
};

export function DocsSidebar() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [searchOpen, setSearchOpen] = useState(false);
  const [isMac, setIsMac] = useState(false);
  const { locale } = useI18n();
  const t = (text: string) => (locale === "es" ? ES_TRANSLATIONS[text] || text : text);

  useEffect(() => {
    if (typeof navigator !== "undefined") {
      setIsMac(/Mac|iPod|iPhone|iPad/.test(navigator.platform));
    }
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <aside className="sticky top-20 h-[calc(100vh-6rem)] overflow-y-auto pr-2">
        <button
          onClick={() => setSearchOpen(true)}
          className="mb-4 flex w-full items-center gap-2 rounded-md border border-border/60 bg-card/50 px-3 py-2 text-left text-[12.5px] text-muted-foreground hover:border-primary/40 hover:bg-card/70"
        >
          <Search className="h-3.5 w-3.5" />
          <span className="flex-1">{locale === "es" ? "Buscar..." : "Search docs…"}</span>
          <kbd className="rounded border border-border/60 bg-background px-1.5 py-0.5 text-[10px] font-mono">
            {isMac ? "⌘K" : "Ctrl K"}
          </kbd>
        </button>

        <nav aria-label="Documentation">
          {DOCS_NAV.map((group) => (
            <div key={group.heading} className="mb-5">
              <div className="mb-1.5 px-2 text-[10.5px] font-semibold uppercase tracking-[0.18em] text-muted-foreground/80">
                {t(group.heading)}
              </div>
              <ul className="flex flex-col">
                {group.entries.map((entry) => {
                  const active = pathname === entry.to;
                  return (
                    <li key={entry.to}>
                      <Link
                        to={entry.to}
                        className={`block rounded-md px-2 py-1.5 text-[12.5px] transition-colors ${
                          active
                            ? "bg-primary/10 text-primary font-medium"
                            : "text-muted-foreground hover:bg-card/60 hover:text-foreground"
                        }`}
                      >
                        {t(entry.label)}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        <div className="mt-6 border-t border-border/60 pt-4 text-[11px] text-muted-foreground/80">
          <div>Nyrava Docs</div>
          <div className="mt-0.5">
            v{DOCS_VERSION.version} — {DOCS_VERSION.channel}
          </div>
          <div className="mt-0.5">{locale === "es" ? "Actualizado" : "Updated"} {DOCS_VERSION.updated}</div>
        </div>
      </aside>

      <DocsSearchDialog open={searchOpen} onOpenChange={setSearchOpen} />
    </>
  );
}
