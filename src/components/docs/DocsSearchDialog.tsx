import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Search, X } from "lucide-react";
import { allEntries } from "@/lib/docs/manifest";
import { useI18n } from "@/i18n";

type Props = { open: boolean; onOpenChange: (open: boolean) => void };

export function DocsSearchDialog({ open, onOpenChange }: Props) {
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const navigate = useNavigate();
  const { locale, t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const entries = useMemo(() => allEntries(), []);

  const results = useMemo(() => {
    if (!q.trim()) return entries.slice(0, 8);
    const needle = q.toLowerCase();
    const scored = entries
      .map((e) => {
        const hay = [e.label, e.description, e.group, ...(e.keywords ?? [])]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        let score = 0;
        if (e.label.toLowerCase().startsWith(needle)) score += 40;
        if (e.label.toLowerCase().includes(needle)) score += 20;
        if (hay.includes(needle)) score += 10;
        for (const kw of e.keywords ?? []) if (kw.toLowerCase().includes(needle)) score += 5;
        return { entry: e, score };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 12)
      .map((r) => r.entry);
    return scored;
  }, [q, entries]);

  useEffect(() => {
    if (open) {
      setQ("");
      setActive(0);
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onOpenChange(false);
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((a) => Math.min(a + 1, Math.max(0, results.length - 1)));
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((a) => Math.max(a - 1, 0));
      }
      if (e.key === "Enter") {
        const target = results[active];
        if (target) {
          onOpenChange(false);
          navigate({ to: target.to });
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, results, active, navigate, onOpenChange]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-background/70 p-4 pt-24 backdrop-blur-sm"
      onClick={() => onOpenChange(false)}
    >
      <div
        className="w-full max-w-xl overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-border px-4">
          <Search className="h-4 w-4 text-muted-foreground" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setActive(0);
            }}
            placeholder={t("docsSearch.placeholder")}
            className="w-full bg-transparent py-4 text-[14px] outline-none placeholder:text-muted-foreground"
          />
          <button
            onClick={() => onOpenChange(false)}
            className="rounded-md p-1 text-muted-foreground hover:text-foreground"
            aria-label={t("docsSearch.close")}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="max-h-[60vh] overflow-y-auto py-2">
          {results.length === 0 && (
            <div className="px-4 py-10 text-center text-[13px] text-muted-foreground">
              {t("docsSearch.noResults")}
            </div>
          )}
          {results.map((r, i) => (
            <button
              key={r.to}
              onMouseEnter={() => setActive(i)}
              onClick={() => {
                onOpenChange(false);
                navigate({ to: r.to });
              }}
              className={`flex w-full flex-col items-start gap-0.5 px-4 py-2.5 text-left ${
                i === active ? "bg-primary/10" : ""
              }`}
            >
              <div className="flex w-full items-center justify-between gap-3">
                <span className="text-[13.5px] font-medium text-foreground">{locale === "es" ? r.labelEs ?? r.label : r.label}</span>
                <span className="text-[10.5px] uppercase tracking-[0.15em] text-muted-foreground/70">
                  {locale === "es" ? r.groupEs ?? r.group : r.group}
                </span>
              </div>
              {r.description && (
                 <span className="text-[12px] text-muted-foreground">{locale === "es" ? r.descriptionEs ?? r.description : r.description}</span>
              )}
            </button>
          ))}
        </div>
        <div className="flex items-center justify-between border-t border-border px-4 py-2 text-[10.5px] text-muted-foreground">
          <span>{t("docsSearch.keyboard")}</span>
          <span>{results.length} {t(results.length === 1 ? "docsSearch.result" : "docsSearch.results")}</span>
        </div>
      </div>
    </div>
  );
}
