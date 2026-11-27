import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export type Locale = "fr-CA" | "en";

const LOCALE_STORAGE_KEY = "paincave_locale";

const MESSAGES = {
  // Navigation & App chrome
  "nav.overview": { "fr-CA": "Aperçu", en: "Overview" },
  "nav.calendar": { "fr-CA": "Calendrier", en: "Calendar" },
  "nav.workouts": { "fr-CA": "Entraînements", en: "Workouts" },
  "nav.trends": { "fr-CA": "Tendances", en: "Trends" },
  "nav.settings": { "fr-CA": "Réglages", en: "Settings" },
  "nav.trainer_app": { "fr-CA": "PainCave : Base d'entraînement", en: "PainCave: Trainer" },
  "nav.trainer_short": { "fr-CA": "Base d'entraînement", en: "Trainer" },
  "nav.back_to_overview": { "fr-CA": "← Retour à l'aperçu", en: "← Back to Overview" },
  "nav.live_ride": { "fr-CA": "Séance en direct", en: "Live Ride" },
  "nav.live_ride_desc": {
    "fr-CA": "ERG, pente, résistance et télémétrie en temps réel",
    en: "ERG, slope, resistance & live telemetry",
  },
  "nav.routes": { "fr-CA": "Parcours", en: "Routes" },
  "nav.routes_desc": {
    "fr-CA": "GPX, mode SIM et profils d'élévation",
    en: "GPX climbs, SIM mode & elevation profiles",
  },
  "nav.bridge": { "fr-CA": "Passerelle", en: "Bridge" },
  "nav.bridge_desc": {
    "fr-CA": "Connexion locale de la base et envoi Strava",
    en: "Local trainer bridge & Strava auto-upload",
  },
  "nav.bridge_connected": { "fr-CA": "Base connectée", en: "Bridge Connected" },
  "nav.bridge_offline": { "fr-CA": "Base hors ligne", en: "Bridge Offline" },
  "nav.loading": { "fr-CA": "Chargement de", en: "Loading" },
  // Overview page
  "overview.title": { "fr-CA": "Aperçu santé et entraînement", en: "Health & Training Overview" },
  "overview.subtitle": {
    "fr-CA": "Toutes vos données physiologiques, séances multisports et notes de mémoire IA au même endroit.",
    en: "Your readiness biometrics, multi-sport training log, and AI memory in one place.",
  },
  "overview.open_trainer": { "fr-CA": "Ouvrir PainCave : Base d'entraînement", en: "Open PainCave: Trainer" },
  "overview.readiness_section": { "fr-CA": "Récupération et biométrie", en: "Readiness & Biometrics" },
  "overview.no_biometrics": {
    "fr-CA": "Aucune donnée biométrique encore. Connectez Garmin Connect dans les réglages pour synchroniser automatiquement VFC, sommeil et fréquence cardiaque au repos.",
    en: "No biometrics synced yet. Connect Garmin Connect in Settings to auto-sync overnight HRV, sleep, and resting heart rate.",
  },
  "overview.hrv_7d": { "fr-CA": "VFC (moy. 7 j)", en: "HRV (7d Avg)" },
  "overview.vs_baseline": { "fr-CA": "vs ligne de base", en: "vs baseline" },
  "overview.rhr_7d": { "fr-CA": "FC au repos (7 j)", en: "Resting HR (7d)" },
  "overview.sleep_7d": { "fr-CA": "Sommeil (moy. 7 j)", en: "Sleep (7d Avg)" },
  "overview.sleep_score": { "fr-CA": "Score", en: "Score" },
  "overview.body_battery": { "fr-CA": "Énergie (pic)", en: "Body Battery Peak" },
  "overview.load_section": { "fr-CA": "Charge et forme", en: "Training Load & Form" },
  "overview.ctl": { "fr-CA": "Forme (CTL)", en: "Fitness (CTL)" },
  "overview.atl": { "fr-CA": "Fatigue (ATL)", en: "Fatigue (ATL)" },
  "overview.tsb": { "fr-CA": "Fraîcheur (TSB)", en: "Form (TSB)" },
  "overview.ramp_7d": { "fr-CA": "Progression 7 j", en: "7d Ramp" },
  "overview.upcoming_section": { "fr-CA": "Séances à venir (7 j)", en: "Upcoming Sessions (7d)" },
  "overview.no_upcoming": {
    "fr-CA": "Aucune séance planifiée cette semaine. Demandez à votre IA d'en créer via MCP.",
    en: "No sessions planned this week. Ask your AI to schedule workouts via MCP.",
  },
  "overview.recent_section": { "fr-CA": "Activités récentes", en: "Recent Activities" },
  "overview.no_recent": {
    "fr-CA": "Aucune activité enregistrée pour l'instant.",
    en: "No activities recorded yet.",
  },
  "overview.memory_section": { "fr-CA": "Mémoire IA", en: "AI Memory" },
  "overview.memory_hint": {
    "fr-CA": "Notes durables enregistrées par votre IA à partir de vos échanges (blessures, préférences, objectifs, contexte de récupération).",
    en: "Durable context saved by your AI from chat (injuries, preferences, goals, recovery notes).",
  },
  "overview.no_memory": {
    "fr-CA": "Aucune note active. Mentionnez un objectif, une sensibilité ou une contrainte à votre IA pour qu'elle le retienne ici.",
    en: "No active memory notes yet. Tell your AI about a goal, niggle, or constraint to persist it here.",
  },
  "overview.archive": { "fr-CA": "Archiver", en: "Archive" },
  "overview.mcp_section": { "fr-CA": "Accès IA (Remote MCP)", en: "AI Access (Remote MCP)" },
  "overview.mcp_hint": {
    "fr-CA": "Connectez Claude, ChatGPT ou Gemini à ce point d'accès pour interroger vos données et créer des entraînements vélo, course ou musculation.",
    en: "Connect Claude, ChatGPT, or Gemini to this endpoint to read your health brief and create bike, run, or strength workouts.",
  },
  "overview.copy_url": { "fr-CA": "Copier l'URL", en: "Copy URL" },
  "overview.copied": { "fr-CA": "Copié!", en: "Copied!" },
  "overview.go_settings": { "fr-CA": "Gérer les connexions", en: "Manage Connections" },

  // Sports
  "sport.all": { "fr-CA": "Tous les sports", en: "All Sports" },
  "sport.cycling": { "fr-CA": "Vélo", en: "Cycling" },
  "sport.running": { "fr-CA": "Course", en: "Running" },
  "sport.strength": { "fr-CA": "Musculation", en: "Strength" },
  "sport.mobility": { "fr-CA": "Mobilité", en: "Mobility" },
  "sport.other": { "fr-CA": "Autre", en: "Other" },

  // Calendar
  "calendar.title": { "fr-CA": "Calendrier d'entraînement", en: "Training Calendar" },
  "calendar.showing": { "fr-CA": "Période du", en: "Showing" },
  "calendar.through": { "fr-CA": "au", en: "through" },
  "calendar.schedule_btn": { "fr-CA": "+ Planifier une séance", en: "+ Schedule Workout" },
  "calendar.close_scheduler": { "fr-CA": "Fermer", en: "Close Scheduler" },
  "calendar.planned": { "fr-CA": "Séances planifiées", en: "Planned Workouts" },
  "calendar.completed": { "fr-CA": "Activités complétées", en: "Completed Activities" },
  "calendar.no_planned": {
    "fr-CA": "Aucune séance planifiée pour cette période. Utilisez votre IA via MCP pour bâtir votre semaine.",
    en: "No planned sessions in this window. Use Remote MCP to plan and schedule workouts for your week.",
  },
  "calendar.no_completed": {
    "fr-CA": "Aucune activité enregistrée pour cette période.",
    en: "No completed activities recorded in this window yet.",
  },
  "calendar.load_trainer": { "fr-CA": "Lancer sur la base", en: "Load on Trainer" },
  "calendar.remove": { "fr-CA": "Retirer", en: "Remove" },
  "calendar.delete": { "fr-CA": "Supprimer", en: "Delete" },
  "calendar.skip": { "fr-CA": "Passer", en: "Skip" },
  "calendar.restore": { "fr-CA": "Rétablir", en: "Restore" },

  // Workouts
  "workouts.title": { "fr-CA": "Bibliothèque d'entraînements", en: "Workout Library" },
  "workouts.schedule": { "fr-CA": "Planifier", en: "Schedule" },
  "workouts.load_trainer": { "fr-CA": "Lancer sur la base", en: "Load on Trainer" },
  "workouts.loading": { "fr-CA": "Chargement...", en: "Loading..." },
  "workouts.delete": { "fr-CA": "Supprimer", en: "Delete" },
  "workouts.deleting": { "fr-CA": "Suppression...", en: "Deleting..." },
  "workouts.import_btn": { "fr-CA": "Importer .zwo / .erg / .mrc", en: "Import .zwo / .erg / .mrc" },
  "workouts.search_placeholder": {
    "fr-CA": "Rechercher nom, notes, catégorie...",
    en: "Search name, notes, category...",
  },
  "workouts.grouped": { "fr-CA": "Groupé", en: "Grouped" },
  "workouts.flat": { "fr-CA": "Toutes les cartes", en: "All Cards" },
  "workouts.reset_filters": { "fr-CA": "Réinitialiser les filtres", en: "Reset filters" },
  "workouts.empty": { "fr-CA": "Aucun entraînement enregistré.", en: "No saved workouts yet." },

  // Trends / Analytics
  "trends.title": { "fr-CA": "Tendances santé et charge", en: "Health & Load Trends" },
  "trends.upload_fit": { "fr-CA": "Importer un fichier .FIT", en: "Upload Outdoor .FIT" },
  "trends.pmc_title": { "fr-CA": "Charge et forme (CTL / ATL / TSB)", en: "Performance Management Chart" },
  "trends.mmp_title": { "fr-CA": "Courbe de puissance maximale (42 j vs 90 j)", en: "Mean Maximal Power Curve (42d vs 90d)" },
  "trends.weekly_title": { "fr-CA": "Volume hebdomadaire (Charge et heures)", en: "Weekly Training Load (TSS & Hours)" },
  "trends.recent_activities": { "fr-CA": "Activités récentes", en: "Recent Activities" },
  "trends.activity_detail": { "fr-CA": "Détails de la séance", en: "Activity & Split Detail" },
  "trends.select_prompt": {
    "fr-CA": "Sélectionnez une activité pour inspecter la courbe FC/puissance, les tours ou intervalles et télécharger le fichier .FIT.",
    en: "Select an activity to inspect its Power/HR chart, laps/intervals, summary PNG card, and sync status.",
  },
  "trends.download_png": { "fr-CA": "Télécharger résumé PNG", en: "Download Summary PNG" },
  "trends.retry_strava": { "fr-CA": "Réessayer Strava", en: "Retry Strava" },

  // Settings
  "settings.title": { "fr-CA": "Réglages et connexions", en: "Settings & Integrations" },
  "settings.thresholds_title": { "fr-CA": "Seuils physiologiques", en: "Athlete Thresholds (Dated Snapshot)" },
  "settings.save_thresholds": { "fr-CA": "Enregistrer les seuils", en: "Save Threshold Snapshot" },
  "settings.apps_title": { "fr-CA": "Applications et modules", en: "Apps & Sport Modules" },
  "settings.trainer_toggle_title": {
    "fr-CA": "Activer PainCave : Base d'entraînement",
    en: "Enable PainCave: Trainer",
  },
  "settings.trainer_toggle_desc": {
    "fr-CA": "Ajoute la sous-application dédiée pour votre base intelligente (KICKR, mode ERG/SIM, parcours GPX et passerelle locale).",
    en: "Adds the dedicated indoor cycling trainer sub-app (KICKR FTMS, ERG/SIM mode, GPX climbs, and local bridge).",
  },
  "settings.garmin_title": { "fr-CA": "Garmin Connect (API personnelle)", en: "Garmin Connect Personal API" },
  "settings.garmin_desc": {
    "fr-CA": "Synchronise automatiquement vos sorties course/vélo/musculation, fichiers .fit, VFC nocturne, sommeil, FC au repos et Body Battery chaque heure. Générez votre clé dans Garmin Connect Web → Paramètres du compte → Clé API personnelle.",
    en: "Auto-ingests Garmin runs, rides, .fit splits, overnight HRV, sleep, resting HR, and Body Battery hourly. Generate your key in Garmin Connect Web → Account Settings → Personal API Key.",
  },
  "settings.connected": { "fr-CA": "Connecté", en: "Connected" },
  "settings.not_connected": { "fr-CA": "Non connecté", en: "Not connected" },
  "settings.connect": { "fr-CA": "Connecter", en: "Connect" },
  "settings.verifying": { "fr-CA": "Vérification...", en: "Verifying..." },
  "settings.sync_now": { "fr-CA": "Synchroniser (7 j)", en: "Sync Now" },
  "settings.syncing": { "fr-CA": "Synchronisation...", en: "Syncing..." },
  "settings.disconnect": { "fr-CA": "Déconnecter", en: "Disconnect" },
  "settings.garmin_backfill_title": {
    "fr-CA": "Importer l'historique Garmin (plage de dates)",
    en: "Import Historical Garmin Data (Date Range)",
  },
  "settings.garmin_backfill_desc": {
    "fr-CA": "Importe automatiquement vos activités passées, fichiers .fit et biométrie par blocs de 7 jours (sans doublons).",
    en: "Pulls past activities, .fit files, and biometrics in safe 7-day chunks (idempotent, duplicate-safe).",
  },
  "settings.from": { "fr-CA": "Du", en: "From" },
  "settings.to": { "fr-CA": "Au", en: "To" },
  "settings.import_range": { "fr-CA": "Importer la période", en: "Import Range" },
  "settings.cancel_import": { "fr-CA": "Arrêter", en: "Stop" },
  "settings.tokens_title": { "fr-CA": "Jetons personnels (Importation archive / MCP / Passerelle)", en: "Personal Tokens (Archive Importer / MCP / Bridge)" },
  "settings.tokens_desc": {
    "fr-CA": "Créez un jeton personnel pour importer vos archives Strava/Garmin en lot via la ligne de commande ou connecter un client MCP.",
    en: "Mint a personal token to run bulk Strava/Garmin ZIP imports via CLI or authenticate a personal MCP/bridge client.",
  },
  "settings.create_token": { "fr-CA": "Créer le jeton", en: "Create Token" },
  "settings.revoke": { "fr-CA": "Révoquer", en: "Revoke" },
  "settings.account_title": { "fr-CA": "Compte et sécurité", en: "Account & Security" },
  "settings.sign_out": { "fr-CA": "Se déconnecter", en: "Sign Out" },
  "settings.mcp_title": { "fr-CA": "Connecteur IA distant (Remote MCP)", en: "Remote MCP — Planning & Analysis" },

  // Auth screen
  "auth.sign_in": { "fr-CA": "Se connecter", en: "Sign In" },
  "auth.create_owner": { "fr-CA": "Créer le compte principal", en: "Create Owner Account" },
  "auth.owner_setup": { "fr-CA": "Configuration initiale", en: "Owner Setup" },
  "auth.single_owner_locked": { "fr-CA": "Accès privé", en: "Single-Owner Locked" },
  "auth.subtitle_signin": {
    "fr-CA": "Connectez-vous à votre plateforme privée de santé et d'entraînement.",
    en: "Sign in to your private health and training instance.",
  },
  "auth.subtitle_setup": {
    "fr-CA": "Créez le compte principal pour activer cette instance.",
    en: "Claim this self-hosted instance by creating the single owner account.",
  },
  "auth.continue_google": { "fr-CA": "Continuer avec Google", en: "Continue with Google" },
  "auth.please_wait": { "fr-CA": "Un instant...", en: "Please wait..." },
} as const;

export type MessageKey = keyof typeof MESSAGES;

interface I18nContextValue {
  locale: Locale;
  setLocale: (next: Locale) => void;
  t: (key: MessageKey) => string;
}

function translate(locale: Locale, key: MessageKey): string {
  return MESSAGES[key][locale];
}

// Standalone fallback defaults to "en" so isolated unit tests rendering pages without App stay backwards-compatible;
// App wraps the runtime UI in <I18nProvider defaultLocale="fr-CA"> so the real UI defaults to Quebec French.
const I18nContext = createContext<I18nContextValue>({
  locale: "en",
  setLocale: () => {},
  t: (key) => translate("en", key),
});

export function I18nProvider({
  defaultLocale = "fr-CA",
  children,
}: {
  defaultLocale?: Locale;
  children: ReactNode;
}) {
  const [locale, setLocaleState] = useState<Locale>(() => {
    if (typeof window === "undefined") return defaultLocale;
    const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (stored === "en" || stored === "fr-CA") return stored;
    return defaultLocale;
  });

  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.lang = locale;
    }
    if (typeof window !== "undefined") {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    }
  }, [locale]);

  const setLocale = (next: Locale) => setLocaleState(next);
  const t = (key: MessageKey) => translate(locale, key);

  return (
    <I18nContext.Provider value={{ locale, setLocale, t }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}
