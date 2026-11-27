import { useEffect, useState } from "react";
import { authClient } from "../lib/auth-client.js";
import type { AuthState } from "../lib/api.js";
import { useI18n } from "../lib/i18n.js";

interface PasskeyPromptBannerProps {
  authState: AuthState;
}

export function PasskeyPromptBanner({ authState }: PasskeyPromptBannerProps) {
  const { locale } = useI18n();
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const userId = authState.user?.id;
  const isBetterAuth = authState.auth_mode === "better_auth" && Boolean(userId);
  const dismissKey = userId ? `paincave_passkey_prompt_dismissed_${userId}` : "";

  useEffect(() => {
    if (!isBetterAuth || typeof window === "undefined") return;
    if (!("PublicKeyCredential" in window)) return;
    if (dismissKey && window.localStorage.getItem(dismissKey) === "1") return;

    let active = true;
    authClient.passkey
      .listUserPasskeys()
      .then((res) => {
        if (!active) return;
        const count = Array.isArray(res.data) ? res.data.length : 0;
        if (count === 0) {
          setVisible(true);
        }
      })
      .catch(() => {
        // Ignore in unsupported environments
      });

    return () => {
      active = false;
    };
  }, [isBetterAuth, dismissKey]);

  const dismiss = () => {
    if (dismissKey && typeof window !== "undefined") {
      window.localStorage.setItem(dismissKey, "1");
    }
    setVisible(false);
  };

  const handleAddPasskey = async () => {
    setBusy(true);
    setError(null);
    try {
      const deviceLabel =
        locale === "fr-CA" ? "Mon appareil" : "My Device";
      const res = await authClient.passkey.addPasskey({ name: deviceLabel });
      if (res?.error) {
        setError(
          res.error.message ??
            (locale === "fr-CA"
              ? "Impossible d'ajouter la clé d'accès."
              : "Could not add passkey.")
        );
      } else {
        setMessage(
          locale === "fr-CA"
            ? "Clé d'accès enregistrée! Vous pourrez vous connecter en un clic."
            : "Passkey saved! You can now sign in with one tap."
        );
        window.setTimeout(() => {
          setVisible(false);
        }, 2500);
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : locale === "fr-CA"
            ? "Configuration annulée."
            : "Passkey setup cancelled."
      );
    } finally {
      setBusy(false);
    }
  };

  if (!visible) return null;

  return (
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-orange-500/30 bg-orange-500/10 px-4 py-3 text-xs">
      <div className="space-y-0.5">
        <div className="font-semibold text-white">
          {locale === "fr-CA"
            ? "Activer la connexion rapide avec clé d'accès (Touch ID / Face ID)?"
            : "Set up 1-tap sign-in with a Passkey (Touch ID / Face ID)?"}
        </div>
        <div className="text-zinc-400">
          {message ??
            (locale === "fr-CA"
              ? "Vous pouvez l'ajouter maintenant ou plus tard dans Réglages → Compte et sécurité."
              : "Add one now for passwordless sign-in, or anytime later in Settings → Account & Security.")}
        </div>
        {error && <div className="text-rose-400">{error}</div>}
      </div>

      {!message && (
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void handleAddPasskey()}
            className="rounded-lg bg-orange-500 px-3 py-1.5 font-bold text-zinc-950 hover:bg-orange-400 disabled:opacity-60"
          >
            {busy
              ? locale === "fr-CA"
                ? "Ajout..."
                : "Adding..."
              : locale === "fr-CA"
                ? "Ajouter une clé d'accès"
                : "Add Passkey"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={dismiss}
            className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 font-semibold text-zinc-300 hover:bg-zinc-800"
          >
            {locale === "fr-CA" ? "Plus tard" : "Not now"}
          </button>
        </div>
      )}
    </div>
  );
}
