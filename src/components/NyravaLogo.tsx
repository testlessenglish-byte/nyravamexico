interface NyravaLogoProps {
  size?: number;
  withWordmark?: boolean;
  className?: string;
  glow?: boolean;
  edition?: string;
}

/**
 * Nyrava primary logo lockup — violet intelligence mark.
 * Wordmark: NYRAVA · LEGAL INTELLIGENCE OS · MÉXICO
 */
export function NyravaLogo({
  size = 40,
  withWordmark = false,
  className = "",
  glow = true,
  edition = "MÉXICO",
}: NyravaLogoProps) {
  return (
    <div className={`flex min-w-0 items-center gap-2 sm:gap-3 ${className}`}>
      <div className="relative shrink-0" style={{ width: size, height: size }}>
        {glow && (
          <div
            aria-hidden
            className="absolute inset-0 -z-0 rounded-full blur-xl"
            style={{ background: "radial-gradient(circle, rgba(124,58,237,0.38), transparent 70%)" }}
          />
        )}
        <svg
          className="relative z-10 h-full w-full"
          viewBox="0 0 40 40"
          fill="none"
          role="img"
          aria-label="Nyrava"
        >
          <defs>
            <linearGradient id="nyrava-mark-gradient" x1="0" y1="0" x2="40" y2="40" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#A78BFA" />
              <stop offset="1" stopColor="#5B21B6" />
            </linearGradient>
          </defs>
          <rect width="40" height="40" rx="10" fill="url(#nyrava-mark-gradient)" />
          <path d="M12 28V12h4.2l9.6 11.4V12H30v16h-4.2L16.2 16.6V28H12z" fill="#FFFFFF" />
        </svg>
      </div>
      {withWordmark && (
        <div className="min-w-0 overflow-hidden leading-none">
          <span
            className="block truncate font-display text-[15px] font-extrabold tracking-[0.06em] text-foreground"
            style={size >= 60 ? { fontSize: 22 } : undefined}
          >
            NYRAVA
          </span>
          <span
            className="mt-1 hidden truncate text-[8.5px] font-semibold tracking-[0.28em] text-muted-foreground sm:block"
            style={size >= 60 ? { fontSize: 11, marginTop: 4 } : undefined}
          >
            LEGAL INTELLIGENCE OS · {edition}
          </span>
        </div>
      )}
    </div>
  );
}
