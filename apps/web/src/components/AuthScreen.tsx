import { useState, type FormEvent } from "react";
import { api, type AuthState } from "../lib/api.js";
import { authClient } from "../lib/auth-client.js";
import { useI18n } from "../lib/i18n.js";
import { useTheme } from "../lib/theme.js";

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
    return "Sign-in blocked: this PainCave instance is locked to its single owner account.";
  }
  return `Sign-in failed (${code.replace(/_/g, " ")}).`;
}

export function AuthScreen({ authState, onAuthenticated }: AuthScreenProps) {
  const { locale, setLocale, t } = useI18n();
  const { theme, toggleTheme } = useTheme();
  const providers = authState.providers ?? {
    email_password: true,
    passkey: true,
    google: false,
    legacy_password: true,
  };
  const hasOwner = authState.has_owner ?? false;
  const [mode, setMode] = useState<"sign_in" | "claim_owner">(
    hasOwner ? "sign_in" : "claim_owner"
  );
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [legacyPassword, setLegacyPassword] = useState("");
  const [showLegacyFallback, setShowLegacyFallback] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(() => getInitialAuthError());

  const returnTo = getSafeReturnTo();

  const finishAuth = async () => {
    if (returnTo !== "/" && typeof window !== "undefined") {
      window.location.assign(returnTo);
      return;
    }
    await onAuthenticated();
  };

  const handleEmailSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      if (mode === "claim_owner" && !hasOwner) {
        const res = await authClient.signUp.email({
          name: name.trim() || "Athlete",
          email: email.trim(),
          password,
        });
        if (res.error) {
          setError(res.error.message ?? "Could not create owner account");
          return;
        }
      } else {
        const res = await authClient.signIn.email({
          email: email.trim(),
          password,
        });
        if (res.error) {
          setError(res.error.message ?? "Invalid email or password");
          return;
        }
      }
      setPassword("");
      await finishAuth();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Authentication failed");
    } finally {
      setSubmitting(false);
    }
  };

  const handleGoogleSignIn = async () => {
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

  const handlePasskeySignIn = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await authClient.signIn.passkey();
      if (res.error) {
        setError(res.error.message ?? "Passkey sign-in failed");
        return;
      }
      await finishAuth();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Passkey sign-in cancelled or failed");
    } finally {
      setSubmitting(false);
    }
  };

  const handleLegacySubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api.login(legacyPassword);
      setLegacyPassword("");
      await finishAuth();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid admin password");
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
            <div className="flex items-center gap-1.5">
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
              <button
                type="button"
                onClick={toggleTheme}
                title={t("theme.toggle_title")}
                className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1 text-[10px] font-semibold text-zinc-300"
              >
                {theme === "light" ? "☀" : "☾"}
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
              ? "Accès privé sur invitation : seuls les comptes autorisés peuvent s'inscrire."
              : "Private invite-only instance: only authorized accounts can register."}
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

        {/* Google OAuth + Passkey Buttons */}
        {(providers.google || (providers.passkey && hasOwner)) && (
          <div className="space-y-2.5">
            {providers.google && (
              <button
                type="button"
                disabled={submitting}
                onClick={() => void handleGoogleSignIn()}
                className="flex w-full items-center justify-center gap-2 rounded-xl border border-zinc-700 bg-zinc-950 py-2.5 text-sm font-semibold text-white transition hover:border-zinc-500 hover:bg-zinc-800 disabled:opacity-60"
              >
                {t("auth.continue_google")}
              </button>
            )}
            {providers.passkey && hasOwner && (
              <button
                type="button"
                disabled={submitting}
                onClick={() => void handlePasskeySignIn()}
                className="flex w-full items-center justify-center gap-2 rounded-xl border border-orange-500/40 bg-orange-500/10 py-2.5 text-sm font-semibold text-orange-200 transition hover:bg-orange-500/20 disabled:opacity-60"
              >
                {t("auth.sign_in_passkey")}
              </button>
            )}
            <div className="flex items-center gap-3 py-1 text-[11px] uppercase tracking-wider text-zinc-500">
              <div className="h-px flex-1 bg-zinc-800" />
              <span>{t("auth.or_email")}</span>
              <div className="h-px flex-1 bg-zinc-800" />
            </div>
          </div>
        )}

        {/* Email & Password Form */}
        {providers.email_password && (
          <form onSubmit={(e) => void handleEmailSubmit(e)} className="space-y-3">
            {!hasOwner && mode === "claim_owner" && (
              <div>
                <label htmlFor="auth-name" className="block text-xs font-medium text-zinc-400">
                  {t("auth.name")}
                </label>
                <input
                  id="auth-name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={locale === "fr-CA" ? "Votre nom" : "Your name"}
                  required
                  className="mt-1 w-full rounded-xl border border-zinc-700 bg-zinc-950 p-3 text-sm text-white focus:border-orange-500 focus:outline-none"
                />
              </div>
            )}
            <div>
              <label htmlFor="auth-email" className="block text-xs font-medium text-zinc-400">
                {t("auth.email")}
              </label>
              <input
                id="auth-email"
                type="email"
                autoComplete="username webauthn"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="vous@exemple.com"
                required
                className="mt-1 w-full rounded-xl border border-zinc-700 bg-zinc-950 p-3 text-sm text-white focus:border-orange-500 focus:outline-none"
              />
            </div>
            <div>
              <label htmlFor="auth-password" className="block text-xs font-medium text-zinc-400">
                {t("auth.password")}
              </label>
              <input
                id="auth-password"
                type="password"
                autoComplete={mode === "claim_owner" ? "new-password" : "current-password"}
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={
                  mode === "claim_owner"
                    ? locale === "fr-CA"
                      ? "Au moins 8 caractères"
                      : "At least 8 characters"
                    : t("auth.password")
                }
                required
                className="mt-1 w-full rounded-xl border border-zinc-700 bg-zinc-950 p-3 text-sm text-white focus:border-orange-500 focus:outline-none"
              />
            </div>
            <button
              type="submit"
              disabled={submitting}
              className="w-full rounded-xl bg-orange-500 py-3 text-sm font-bold text-zinc-950 hover:bg-orange-400 disabled:opacity-60"
            >
              {submitting
                ? t("auth.please_wait")
                : mode === "claim_owner" && !hasOwner
                  ? t("auth.create_owner")
                  : t("auth.sign_in")}
            </button>

            {!hasOwner && (
              <button
                type="button"
                onClick={() => setMode(mode === "claim_owner" ? "sign_in" : "claim_owner")}
                className="w-full text-center text-xs text-zinc-400 hover:text-zinc-200"
              >
                {mode === "claim_owner"
                  ? "Already have an account? Sign in"
                  : "First time here? Create owner account"}
              </button>
            )}
          </form>
        )}

        {/* Legacy Admin Password Fallback */}
        {providers.legacy_password && (
          <div className="border-t border-zinc-800 pt-3">
            <button
              type="button"
              onClick={() => setShowLegacyFallback((open) => !open)}
              className="text-xs text-zinc-500 hover:text-zinc-300"
            >
              {showLegacyFallback ? "Hide Admin Password Fallback" : "Use Legacy Admin Password"}
            </button>
            {showLegacyFallback && (
              <form onSubmit={(e) => void handleLegacySubmit(e)} className="mt-3 flex gap-2">
                <input
                  type="password"
                  value={legacyPassword}
                  onChange={(e) => setLegacyPassword(e.target.value)}
                  placeholder="Admin Password"
                  aria-label="Legacy Admin Password"
                  required
                  className="flex-1 rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white"
                />
                <button
                  type="submit"
                  disabled={submitting}
                  className="rounded-xl border border-zinc-700 bg-zinc-800 px-4 py-2 text-xs font-bold text-white hover:bg-zinc-700 disabled:opacity-60"
                >
                  Unlock
                </button>
              </form>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
