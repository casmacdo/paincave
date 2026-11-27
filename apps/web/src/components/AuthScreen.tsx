import { useState, type FormEvent } from "react";
import type { AuthState } from "../lib/api.js";
import { authClient } from "../lib/auth-client.js";
import { useI18n } from "../lib/i18n.js";

interface AuthScreenProps {
  authState: AuthState;
  onAuthenticated: () => Promise<void>;
}

function getSafeReturnTo(): string {
  if (typeof window === "undefined") return "/";
  const raw = new URLSearchParams(window.location.search).get("returnTo");
  if (raw && raw.startsWith("/") && !raw.startsWith("//")) {
    return raw;
  }
  return "/";
}

function getInitialAuthError(): string | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  const code = params.get("error");
  if (!code) return null;
  const description = params.get("error_description");
  if (description) return description;
  if (code === "signup_disabled" || code === "unable_to_create_user") {
    return "Sign-in blocked: this PainCave instance is locked to its allowlist or owner account.";
  }
  return `Sign-in failed (${code.replace(/_/g, " ")}).`;
}

export function AuthScreen({ authState }: AuthScreenProps) {
  const { locale, setLocale, t } = useI18n();
  const providers = authState.providers ?? { google: false };
  const hasOwner = authState.has_owner ?? false;
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(() => getInitialAuthError());
  const returnTo = getSafeReturnTo();

  const handleGoogleSignIn = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await authClient.signIn.social({
        provider: "google",
        callbackURL: returnTo,
        errorCallbackURL: "/",
      });
      if (res.error) {
        setError(res.error.message ?? "Could not start Google sign-in");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start Google sign-in");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-950 p-4">
      <div className="w-full max-w-md space-y-5 rounded-2xl border border-zinc-800 bg-zinc-900 p-6 shadow-2xl">
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <h1 className="text-2xl font-black tracking-tight text-white">
              Pain<span className="text-orange-500">Cave</span>
            </h1>
            <div className="inline-flex rounded-lg border border-zinc-700 bg-zinc-950 p-0.5 text-[10px] font-semibold">
              <button
                type="button"
                onClick={() => setLocale("fr-CA")}
                className={`rounded px-1.5 py-0.5 ${
                  locale === "fr-CA" ? "bg-orange-500 text-zinc-950" : "text-zinc-400"
                }`}
              >
                FR
              </button>
              <button
                type="button"
                onClick={() => setLocale("en")}
                className={`rounded px-1.5 py-0.5 ${
                  locale === "en" ? "bg-orange-500 text-zinc-950" : "text-zinc-400"
                }`}
              >
                EN
              </button>
            </div>
          </div>
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm text-zinc-400">
              {hasOwner ? t("auth.subtitle_signin") : t("auth.subtitle_setup")}
            </p>
            <span className="shrink-0 rounded-full border border-zinc-700 bg-zinc-950 px-2.5 py-0.5 text-[11px] font-semibold text-zinc-300">
              {hasOwner ? t("auth.single_owner_locked") : t("auth.owner_setup")}
            </span>
          </div>
        </div>

        {!hasOwner && (
          <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-emerald-200">
            {locale === "fr-CA"
              ? "Cette instance privée utilise Google. Le premier compte autorisé devient le propriétaire."
              : "This private instance uses Google. The first authorized account becomes the owner."}
          </div>
        )}

        {error && (
          <div
            role="alert"
            className="rounded-xl border border-rose-500/40 bg-rose-500/15 p-3 text-xs text-rose-200"
          >
            {error}
          </div>
        )}

        {providers.google ? (
          <form onSubmit={(event) => void handleGoogleSignIn(event)}>
            <button
              type="submit"
              disabled={submitting}
              className="flex w-full items-center justify-center gap-2 rounded-xl border border-zinc-700 bg-zinc-950 py-3 text-sm font-semibold text-white transition hover:border-zinc-500 hover:bg-zinc-800 disabled:opacity-60"
            >
              {submitting
                ? t("auth.please_wait")
                : t("auth.continue_google")}
            </button>
          </form>
        ) : (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
            {locale === "fr-CA"
              ? "La connexion Google n'est pas configurée."
              : "Google sign-in is not configured."}
          </div>
        )}
      </div>
    </div>
  );
}
