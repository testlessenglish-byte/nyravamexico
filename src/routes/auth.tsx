import { createFileRoute, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { NyravaLogo } from "@/components/NyravaLogo";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { ArrowLeft, CheckCircle2, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { lovable } from "@/integrations/lovable";
import { useI18n } from "@/i18n";

function getSafeRedirectTarget(searchRedirect?: string): string {
  if (
    searchRedirect &&
    searchRedirect.startsWith("/") &&
    !searchRedirect.startsWith("//") &&
    searchRedirect !== "/auth"
  ) {
    return searchRedirect;
  }
  if (typeof window !== "undefined") {
    const params = new URLSearchParams(window.location.search);
    const param = params.get("redirect");
    if (param && param.startsWith("/") && !param.startsWith("//") && param !== "/auth") {
      return param;
    }
  }
  return "/dashboard";
}

export const Route = createFileRoute("/auth")({
  validateSearch: (
    search: Record<string, unknown>,
  ): { redirect?: string; mode?: "signin" | "signup" | "forgot" | "reset"; logged_out?: string } => {
    return {
      redirect: typeof search.redirect === "string" ? search.redirect : undefined,
      mode:
        search.mode === "signin" ||
        search.mode === "signup" ||
        search.mode === "forgot" ||
        search.mode === "reset"
          ? search.mode
          : undefined,
      logged_out: typeof search.logged_out === "string" ? search.logged_out : undefined,
    };
  },
  head: () => ({
    meta: [
      { title: "Acceso · Nyrava Intelligence México" },
      {
        name: "description",
        content:
          "Accede a Nyrava Intelligence México — Legal Intelligence OS para el sistema jurídico mexicano.",
      },
      { property: "og:title", content: "Acceso · Nyrava México" },
      { property: "og:description", content: "Inicia sesión o crea tu cuenta." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
    links: [{ rel: "canonical", href: "https://mexico.nyrava.com/auth" }],
  }),
  component: AuthPage,
});

function AuthPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const router = useRouter();
  const { t } = useI18n();

  const [mode, setMode] = useState<"signin" | "signup" | "forgot" | "reset">(
    search.mode || "signin",
  );
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const destination = getSafeRedirectTarget(search.redirect);

  useEffect(() => {
    // If explicitly logged out or in password recovery mode, do not auto-redirect
    const urlParams = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
    const isLoggedOut = Boolean(search.logged_out || urlParams?.get("logged_out"));
    if (isLoggedOut || mode === "forgot" || mode === "reset") {
      return;
    }

    supabase.auth.getUser().then(({ data }) => {
      if (data.user) {
        void router.invalidate().then(() => {
          if (destination.startsWith("/")) {
            window.location.replace(destination);
          } else {
            navigate({ to: "/dashboard", replace: true });
          }
        });
      }
    });
  }, [destination, mode, navigate, router, search.logged_out]);

  async function enterWorkspace() {
    const { data, error: userError } = await supabase.auth.getUser();
    if (userError || !data.user) throw userError ?? new Error(t("common.error.auth"));
    await router.invalidate();
    if (destination.startsWith("/")) {
      window.location.replace(destination);
    } else {
      await navigate({ to: "/dashboard", replace: true });
    }
  }

  async function handleEmail(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccessMessage(null);
    setLoading(true);

    try {
      if (mode === "forgot") {
        const { error } = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: `${window.location.origin}/auth?mode=reset`,
        });
        if (error) throw error;
        setSuccessMessage(t("auth.forgotPassword.success"));
        return;
      }

      if (mode === "reset") {
        if (password !== confirmPassword) {
          throw new Error("Las contraseñas no coinciden.");
        }
        const { error } = await supabase.auth.updateUser({ password });
        if (error) throw error;
        setSuccessMessage(t("auth.resetPassword.success"));
        setTimeout(() => {
          void enterWorkspace();
        }, 1200);
        return;
      }

      if (mode === "signup") {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: window.location.origin, data: { full_name: fullName } },
        });
        if (error) throw error;
        const { data } = await supabase.auth.getSession();
        if (!data.session) {
          setSuccessMessage(
            "Revisa tu correo para confirmar tu cuenta antes de iniciar sesión."
          );
          return;
        }
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
      await enterWorkspace();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("common.error.auth"));
    } finally {
      setLoading(false);
    }
  }

  async function handleGoogle() {
    setError(null);
    setSuccessMessage(null);
    setLoading(true);

    // Pass prompt: select_account so Google prompts the user to select which account to sign in with
    const result = await lovable.auth.signInWithOAuth("google", {
      redirect_uri: window.location.origin,
      extraParams: {
        prompt: "select_account",
      },
    });

    if (result.error) {
      // Fallback to Supabase direct OAuth with select_account prompt
      const { error: sbError } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: window.location.origin,
          queryParams: {
            prompt: "select_account",
            access_type: "offline",
          },
        },
      });
      if (sbError) {
        setError(sbError.message ?? t("auth.google.error"));
        setLoading(false);
        return;
      }
      return;
    }

    if (result.redirected) return;
    try {
      await enterWorkspace();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("common.error.auth"));
      setLoading(false);
    }
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center px-6">
      <div className="pointer-events-none absolute inset-0 divider-grid opacity-[0.35]" aria-hidden />
      <div className="absolute right-6 top-6">
        <LanguageSwitcher />
      </div>
      <div className="relative w-full max-w-md">
        <Link
          to="/"
          className="mb-8 inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground transition hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> {t("common.back")}
        </Link>
        <div className="panel p-8">
          <div className="flex flex-col items-center">
            <NyravaLogo size={56} />
            <h1 className="mt-6 font-display text-2xl font-semibold tracking-tight text-center">
              {mode === "signin"
                ? t("auth.signIn.title")
                : mode === "signup"
                  ? t("auth.signUp.title")
                  : mode === "forgot"
                    ? t("auth.forgotPassword.title")
                    : t("auth.resetPassword.title")}
            </h1>
            <p className="mt-2 text-center text-sm text-muted-foreground">
              {mode === "signin"
                ? t("auth.signIn.subtitle")
                : mode === "signup"
                  ? t("auth.signUp.subtitle")
                  : mode === "forgot"
                    ? t("auth.forgotPassword.subtitle")
                    : t("auth.resetPassword.subtitle")}
            </p>
          </div>

          {(mode === "signin" || mode === "signup") && (
            <>
              <button
                type="button"
                onClick={handleGoogle}
                disabled={loading}
                className="mt-6 flex w-full items-center justify-center gap-3 rounded-md border border-border/70 bg-background/60 py-2.5 text-sm font-medium text-foreground transition hover:bg-background disabled:opacity-50"
              >
                <svg width="16" height="16" viewBox="0 0 48 48">
                  <path
                    fill="#EA4335"
                    d="M24 9.5c3.5 0 6.6 1.2 9 3.5l6.7-6.7C35.5 2.4 30.1 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.8 6.1C12.3 13.2 17.7 9.5 24 9.5z"
                  />
                  <path
                    fill="#4285F4"
                    d="M46.5 24.5c0-1.6-.1-3.2-.4-4.7H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8c4.4-4 6.9-9.9 6.9-17.3z"
                  />
                  <path
                    fill="#FBBC05"
                    d="M10.4 28.7c-.5-1.4-.7-2.9-.7-4.7s.3-3.3.7-4.7l-7.8-6.1C1 16.9 0 20.3 0 24s1 7.1 2.6 10.8l7.8-6.1z"
                  />
                  <path
                    fill="#34A853"
                    d="M24 48c6.1 0 11.3-2 15.1-5.5l-7.5-5.8c-2.1 1.4-4.8 2.3-7.6 2.3-6.3 0-11.7-3.7-13.6-9.8l-7.8 6.1C6.5 42.6 14.6 48 24 48z"
                  />
                </svg>
                {t("auth.google")}
              </button>

              <div className="mt-6 flex items-center gap-3 text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                <div className="h-px flex-1 bg-border/60" /> {t("auth.divider")}{" "}
                <div className="h-px flex-1 bg-border/60" />
              </div>
            </>
          )}

          <form onSubmit={handleEmail} className="mt-4 space-y-3">
            {mode === "signup" && (
              <input
                type="text"
                placeholder={t("auth.field.fullName")}
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                className="w-full rounded-md border border-border/70 bg-background/60 px-3 py-2.5 text-sm placeholder:text-muted-foreground/60 focus:border-primary focus:outline-none"
              />
            )}

            {mode !== "reset" && (
              <input
                type="email"
                required
                placeholder={t("auth.field.email")}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-md border border-border/70 bg-background/60 px-3 py-2.5 text-sm placeholder:text-muted-foreground/60 focus:border-primary focus:outline-none"
              />
            )}

            {(mode === "signin" || mode === "signup" || mode === "reset") && (
              <div className="space-y-1">
                <input
                  type="password"
                  required
                  minLength={8}
                  placeholder={
                    mode === "reset"
                      ? t("auth.field.password")
                      : t("auth.field.password")
                  }
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full rounded-md border border-border/70 bg-background/60 px-3 py-2.5 text-sm placeholder:text-muted-foreground/60 focus:border-primary focus:outline-none"
                />
                {mode === "signin" && (
                  <div className="flex justify-end pt-1">
                    <button
                      type="button"
                      onClick={() => {
                        setMode("forgot");
                        setError(null);
                        setSuccessMessage(null);
                      }}
                      className="text-xs text-primary/80 hover:text-primary transition hover:underline"
                    >
                      {t("auth.forgotPassword.link")}
                    </button>
                  </div>
                )}
              </div>
            )}

            {mode === "reset" && (
              <input
                type="password"
                required
                minLength={8}
                placeholder={t("auth.resetPassword.confirmPassword")}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="w-full rounded-md border border-border/70 bg-background/60 px-3 py-2.5 text-sm placeholder:text-muted-foreground/60 focus:border-primary focus:outline-none"
              />
            )}

            {error && (
              <div className="rounded-md border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive">
                {error}
              </div>
            )}

            {successMessage && (
              <div className="flex items-center gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 p-2.5 text-xs text-emerald-400">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                <span>{successMessage}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="flex w-full items-center justify-center gap-2 rounded-md bg-primary py-3 text-[12px] font-semibold uppercase tracking-[0.18em] text-primary-foreground transition hover:brightness-110 disabled:opacity-50"
            >
              {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {mode === "signin"
                ? t("auth.submit.signIn")
                : mode === "signup"
                  ? t("auth.submit.signUp")
                  : mode === "forgot"
                    ? t("auth.forgotPassword.submit")
                    : t("auth.resetPassword.submit")}
            </button>
          </form>

          {mode === "forgot" ? (
            <button
              type="button"
              onClick={() => {
                setMode("signin");
                setError(null);
                setSuccessMessage(null);
              }}
              className="mt-4 w-full text-center text-xs text-muted-foreground transition hover:text-foreground"
            >
              {t("auth.forgotPassword.back")}
            </button>
          ) : mode === "reset" ? (
            <button
              type="button"
              onClick={() => {
                setMode("signin");
                setError(null);
                setSuccessMessage(null);
              }}
              className="mt-4 w-full text-center text-xs text-muted-foreground transition hover:text-foreground"
            >
              {t("auth.forgotPassword.back")}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                setMode(mode === "signin" ? "signup" : "signin");
                setError(null);
                setSuccessMessage(null);
              }}
              className="mt-4 w-full text-center text-xs text-muted-foreground transition hover:text-foreground"
            >
              {mode === "signin" ? t("auth.toggle.toSignUp") : t("auth.toggle.toSignIn")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
