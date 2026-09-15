import { useCaseTranslation } from "@/hooks/useCaseTranslation";
import { useI18n } from "@/i18n";
import { presentStoredText } from "@/lib/social/stored-text-presentation";
import { Loader2 } from "lucide-react";

type Props = {
  text?: string | null;
  label?: string;
  className?: string;
  allowOriginal?: boolean;
  fallback?: string;
};

export function CaseDynamicText({
  text,
  label,
  className = "",
  allowOriginal = true,
  fallback = "—",
}: Props) {
  const { locale } = useI18n();
  const es = locale === "es";
  const {
    displayText,
    isTranslated,
    isTranslating,
    showingOriginal,
    toggleOriginal,
  } = useCaseTranslation(text);

  if (!text || !text.trim()) {
    return <span className={`text-muted-foreground ${className}`}>{fallback}</span>;
  }

  return (
    <div className={className}>
      {label && (
        <div className="flex items-center justify-between gap-2 mb-1">
          <span className="text-xs font-semibold text-muted-foreground">{label}</span>
          {allowOriginal && isTranslated && (
            <button
              type="button"
              onClick={toggleOriginal}
              className="text-[11px] font-medium text-primary hover:underline"
            >
              {showingOriginal
                ? (es ? "Ver traducción" : "View translation")
                : (es ? "Ver original" : "View original")}
            </button>
          )}
        </div>
      )}
      <div className="relative">
        <p className="whitespace-pre-wrap text-sm text-foreground leading-relaxed">
          {presentStoredText(displayText ?? "", locale)}
          {isTranslating && (
            <span className="ml-2 inline-flex items-center text-xs text-muted-foreground">
              <Loader2 className="mr-1 inline h-3 w-3 animate-spin" />
              {es ? "Traduciendo…" : "Translating…"}
            </span>
          )}
        </p>
        {!label && allowOriginal && isTranslated && (
          <button
            type="button"
            onClick={toggleOriginal}
            className="mt-1 block text-[11px] font-medium text-primary hover:underline"
          >
            {showingOriginal
              ? (es ? "Ver traducción" : "View translation")
              : (es ? "Ver original" : "View original")}
          </button>
        )}
      </div>
    </div>
  );
}
