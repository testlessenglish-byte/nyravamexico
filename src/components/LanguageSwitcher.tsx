import { ChevronDown } from "lucide-react";
import { useI18n, LOCALES, type Locale } from "@/i18n";
import { cn } from "@/lib/utils";

type Variant = "header" | "sidebar" | "inline";

const FLAG: Record<Locale, string> = { es: "🇲🇽", en: "🇺🇸" };

export function LanguageSwitcher({
  variant = "header",
  className = "",
}: {
  variant?: Variant;
  className?: string;
}) {
  const { locale, setLocale, t } = useI18n();

  // In the mobile drawer, render direct tap buttons instead of a native
  // <select>: the native picker is unreliable on phones when nested inside
  // a modal sheet (picker fails to open / auto-zoom dismisses it).
  if (variant === "sidebar") {
    return (
      <div
        role="group"
        aria-label={t("common.language")}
        className={cn("grid grid-cols-2 gap-2", className)}
      >
        {LOCALES.map((l) => {
          const active = locale === l;
          return (
            <button
              key={l}
              type="button"
              aria-pressed={active}
              onClick={() => setLocale(l)}
              className={cn(
                "flex items-center justify-center gap-1.5 rounded-md border px-2 py-2 text-[11px] font-semibold tracking-[0.14em] uppercase transition",
                active
                  ? "border-primary/60 bg-primary/10 text-foreground"
                  : "border-border bg-transparent text-muted-foreground hover:border-primary/50 hover:text-foreground",
              )}
            >
              <span aria-hidden className="text-[13px] leading-none">
                {FLAG[l]}
              </span>
              {l === "es" ? t("common.language.es") : t("common.language.en")}
            </button>
          );
        })}
      </div>
    );
  }

  const sizing =
    variant === "sidebar" ? "px-2 py-1" : variant === "inline" ? "px-2 py-1" : "px-2.5 py-2";

  return (
    <label
      className={cn(
        "relative inline-flex items-center gap-1.5 rounded-md border border-border bg-transparent text-[11px] font-semibold tracking-[0.14em] text-foreground transition hover:border-primary/50 focus-within:border-primary/60",
        sizing,
        className,
      )}
      aria-label={t("common.language")}
    >
      <span aria-hidden className="text-[13px] leading-none">
        {FLAG[locale]}
      </span>
      <select
        value={locale}
        onChange={(e) => setLocale(e.target.value as Locale)}
        className="cursor-pointer appearance-none bg-transparent pr-4 uppercase focus:outline-none"
      >
        {LOCALES.map((l) => (
          <option key={l} value={l} className="bg-background text-foreground">
            {l === "es" ? t("common.language.es") : t("common.language.en")}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2 h-3 w-3" aria-hidden />
    </label>
  );
}
