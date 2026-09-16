import { useState, useEffect, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Search, Briefcase, User, FileText, Loader2 } from "lucide-react";
import { globalLegalSearch, type SearchResults } from "@/lib/crm-search.functions";

export function GlobalSearch() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResults>({ cases: [], clients: [], documents: [] });
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const searchFn = useServerFn(globalLegalSearch);
  const inputRef = useRef<HTMLInputElement>(null);

  // Cmd+K / Ctrl+K shortcut
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    document.addEventListener("keydown", down);
    return () => document.removeEventListener("keydown", down);
  }, []);

  // Reset on open
  useEffect(() => {
    if (open) {
      setQuery("");
      setResults({ cases: [], clients: [], documents: [] });
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [open]);

  // Debounced search
  useEffect(() => {
    if (!query.trim()) {
      setResults({ cases: [], clients: [], documents: [] });
      return;
    }
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const data = await searchFn({ data: { query: query.trim() } });
        setResults(data ?? { cases: [], clients: [], documents: [] });
      } catch {
        // Silently handle — search is best-effort
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [query, searchFn]);

  const hasResults =
    results.cases.length > 0 || results.clients.length > 0 || results.documents.length > 0;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 rounded-md border border-border bg-card/60 px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent/10 transition-colors"
      >
        <Search className="h-4 w-4" />
        <span>Buscar...</span>
        <kbd className="ml-auto pointer-events-none inline-flex h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground">
          <span className="text-xs">⌘</span>K
        </kbd>
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="overflow-hidden p-0 max-w-2xl gap-0">
          <DialogTitle className="sr-only">Búsqueda Global</DialogTitle>
          <div className="flex items-center border-b border-border px-3">
            <Search className="mr-2 h-4 w-4 shrink-0 opacity-50 text-primary" />
            <input
              ref={inputRef}
              className="flex h-12 w-full rounded-md bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground"
              placeholder="Buscar expedientes, clientes, documentos..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin opacity-50" />}
          </div>

          <div className="max-h-[60vh] overflow-y-auto overflow-x-hidden">
            {query.trim() !== "" && !hasResults && !loading && (
              <div className="py-6 text-center text-sm text-muted-foreground">
                No se encontraron resultados para &quot;{query}&quot;
              </div>
            )}

            {/* Clients */}
            {results.clients.length > 0 && (
              <div className="p-2">
                <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground">
                  CLIENTES
                </div>
                {results.clients.map((client) => (
                  <button
                    key={client.id}
                    onClick={() => {
                      setOpen(false);
                      navigate({ to: "/clients/$clientId", params: { clientId: client.id } });
                    }}
                    className="flex w-full cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-primary/10 hover:text-primary transition-colors"
                  >
                    <User className="mr-2 h-4 w-4 shrink-0" />
                    <div className="flex flex-col items-start min-w-0">
                      <span className="truncate font-medium">{client.display_name}</span>
                      <span className="text-xs text-muted-foreground">
                        {client.client_type === "company" ? "Empresa" : "Persona"} ·{" "}
                        {client.case_count} expediente{client.case_count !== 1 ? "s" : ""}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            )}

            {/* Cases */}
            {results.cases.length > 0 && (
              <div className="p-2">
                <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground">
                  EXPEDIENTES
                </div>
                {results.cases.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => {
                      setOpen(false);
                      navigate({ to: "/cases/$caseId", params: { caseId: c.id } });
                    }}
                    className="flex w-full cursor-default select-none items-center justify-between rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-primary/10 hover:text-primary transition-colors"
                  >
                    <div className="flex items-center min-w-0">
                      <Briefcase className="mr-2 h-4 w-4 shrink-0" />
                      <div className="flex flex-col items-start min-w-0">
                        <span className="truncate font-medium">
                          {c.case_number || c.title || "Sin título"}
                        </span>
                        <span className="text-xs text-muted-foreground truncate">
                          {c.client_name && `${c.client_name} · `}
                          {c.matter_type || ""}
                        </span>
                      </div>
                    </div>
                    {c.status && (
                      <span className="ml-2 shrink-0 text-xs px-2 py-0.5 rounded-full bg-primary/10 text-primary">
                        {c.status}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}

            {/* Documents */}
            {results.documents.length > 0 && (
              <div className="p-2">
                <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground">
                  DOCUMENTOS
                </div>
                {results.documents.map((doc) => (
                  <button
                    key={doc.id}
                    onClick={() => {
                      setOpen(false);
                      navigate({ to: "/cases/$caseId", params: { caseId: doc.case_id } });
                    }}
                    className="flex w-full cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-primary/10 hover:text-primary transition-colors"
                  >
                    <FileText className="mr-2 h-4 w-4 shrink-0" />
                    <div className="flex flex-col items-start min-w-0">
                      <span className="truncate">{doc.filename}</span>
                      <span className="text-xs text-muted-foreground">
                        {doc.case_number || doc.case_title || ""}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
