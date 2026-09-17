import { useI18n } from "@/i18n";

/**
 * Pipeline flow SVG diagram used on the Trust Center and How It Works pages.
 * Renders cleanly in both light and dark themes via CSS custom properties.
 */
export function PipelineDiagram({ className = "" }: { className?: string }) {
  const { t } = useI18n();
  const steps = Array.from({ length: 9 }, (_, index) => t(`pipelineDiagram.step${index + 1}`));
  const W = 720;
  const stepH = 46;
  const gap = 12;
  const H = steps.length * (stepH + gap) + 20;
  return (
    <div className={`my-6 overflow-x-auto rounded-lg border border-border/60 bg-card/30 p-6 ${className}`}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={t("pipelineDiagram.ariaLabel")}
        className="mx-auto block w-full max-w-[720px]"
      >
        <defs>
          <marker
            id="arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" className="text-primary" />
          </marker>
        </defs>
        {steps.map((s, i) => {
          const y = i * (stepH + gap) + 6;
          const isReview = i === steps.length - 2;
          const isFinal = i === steps.length - 1;
          return (
            <g key={s}>
              <rect
                x={W / 2 - 220}
                y={y}
                width={440}
                height={stepH}
                rx={10}
                className={
                  isReview
                    ? "fill-primary/10 stroke-primary/60"
                    : isFinal
                    ? "fill-primary/20 stroke-primary"
                    : "fill-card stroke-border"
                }
                strokeWidth={1}
              />
              <text
                x={W / 2}
                y={y + stepH / 2 + 5}
                textAnchor="middle"
                className="fill-foreground text-[14px] font-medium"
                style={{ fontFamily: "inherit" }}
              >
                {s}
              </text>
              {i < steps.length - 1 && (
                <line
                  x1={W / 2}
                  y1={y + stepH}
                  x2={W / 2}
                  y2={y + stepH + gap}
                  stroke="currentColor"
                  strokeWidth={1.5}
                  className="text-primary/60"
                  markerEnd="url(#arrow)"
                />
              )}
            </g>
          );
        })}
      </svg>
      <p className="mt-4 text-center text-[11px] text-muted-foreground">
        {t("pipelineDiagram.caption")}
      </p>
    </div>
  );
}
