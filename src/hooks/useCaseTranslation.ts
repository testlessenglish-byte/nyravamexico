import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { translateTexts } from "@/lib/cases.functions";
import { useI18n, type Locale } from "@/i18n";
import { useState, useMemo } from "react";

function hashText(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return `${text.length}:${h}`;
}

export function isLikelyDifferentLanguage(text: string, targetLocale: Locale): boolean {
  if (!text || text.trim().length < 2) return false;
  const lower = text.toLowerCase();
  if (targetLocale === "es") {
    const englishWords = /\b(the|and|is|are|was|were|this|that|with|for|from|have|has|had|will|would|should|could|client|reports|reporting|violence|abuse|needs|family|case|intake|risk|plan|goal|actions|outcome|required|follow|assessment|immediate|protective|factors|override|closure|services|completed|under|review)\b/i;
    return englishWords.test(lower);
  } else {
    const spanishWords = /\b(el|la|los|las|un|una|unos|unas|del|por|para|con|sin|sobre|que|quien|cual|este|esta|estos|estas|persona|caso|violencia|informe|atención|atencion|necesidad|riesgo|protección|proteccion|seguimiento|evaluación|evaluacion|canalización|canalizacion|albergue|apoyo|salud|familiar|legal|plan|meta|acción|accion|resultado|cierre|servicios|revisión|revision)\b/i;
    const spanishChars = /[áéíóúüñ¿¡]/i;
    return spanishWords.test(lower) || spanishChars.test(lower);
  }
}

/**
 * Presentation-layer dynamic translation hook for Comprehensive Care.
 * Never mutates canonical database records.
 * Caches results per locale and content hash.
 */
export function useCaseTranslation(
  text: string | null | undefined,
  options?: { sourceLocale?: Locale; forceCheck?: boolean }
): {
  displayText: string;
  originalText: string;
  isTranslating: boolean;
  isTranslated: boolean;
  showingOriginal: boolean;
  toggleOriginal: () => void;
} {
  const { locale } = useI18n();
  const fetchTranslate = useServerFn(translateTexts);
  const [showOriginal, setShowOriginal] = useState(false);
  const raw = text?.trim() ?? "";

  const needsTranslation = useMemo(() => {
    if (!raw) return false;
    if (options?.sourceLocale && options.sourceLocale === locale) return false;
    if (options?.forceCheck) return true;
    return isLikelyDifferentLanguage(raw, locale);
  }, [raw, options?.sourceLocale, options?.forceCheck, locale]);

  const query = useQuery({
    queryKey: ["case-field-translate", locale, hashText(raw)],
    queryFn: async () => {
      const res = await fetchTranslate({ data: { texts: [raw], targetLocale: locale } });
      return res.translations?.[0] ?? raw;
    },
    enabled: needsTranslation && raw.length > 0,
    staleTime: Infinity,
    gcTime: 60 * 60 * 1000,
  });

  const translated = query.data ?? raw;
  const isDifferent = Boolean(translated && translated !== raw);

  return {
    displayText: showOriginal ? raw : (translated || raw),
    originalText: raw,
    isTranslating: query.isFetching && !query.data,
    isTranslated: isDifferent,
    showingOriginal: showOriginal,
    toggleOriginal: () => setShowOriginal((v) => !v),
  };
}
