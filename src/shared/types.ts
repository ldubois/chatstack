export const DEFAULT_CHAT_URL = 'https://chat.google.com/';

export const ACCOUNT_COLORS = [
  '#10B981', '#3B82F6', '#8B5CF6', '#EC4899', '#F59E0B', '#EF4444', '#14B8A6', '#6366F1',
];

/** Valeur de `dndUntil` pour « Ne pas déranger » sans limite de durée. */
export const DND_FOREVER = Number.MAX_SAFE_INTEGER;

export interface Account {
  id: string;
  name: string;
  color: string;
  url: string;
  /** Notifications natives macOS pour ce compte. */
  notifications: boolean;
  /** Son des notifications. */
  sound: boolean;
  /** Compte pris en compte dans le badge du Dock / la barre des menus. */
  includeInBadge: boolean;
  zoom: number;
}

export type DockBounce = 'none' | 'informational' | 'critical';
export type BadgeMode = 'count' | 'dot' | 'none';

export interface Settings {
  accounts: Account[];
  activeAccountId: string | null;
  /** Timestamp (ms) de fin du mode Ne pas déranger, 0 = désactivé. */
  dndUntil: number;
  showPreview: boolean;
  dockBounce: DockBounce;
  badgeMode: BadgeMode;
  showTray: boolean;
  launchAtLogin: boolean;
  /** Fermer la fenêtre la masque, l'app reste active pour les alertes. */
  closeToBackground: boolean;
  /** Ouvre les liens Google Meet dans le navigateur par défaut. */
  meetInBrowser: boolean;
  windowBounds?: { x: number; y: number; width: number; height: number };
}

export interface AccountState {
  id: string;
  unread: number;
  /** Notification reçue et pas encore vue dans l'app. */
  attention: boolean;
  loading: boolean;
  crashed: boolean;
  /** E-mail détecté dans la page une fois connecté. */
  email: string | null;
  /** La vue est sur la page de connexion Google (compte pas encore connecté). */
  signedOut: boolean;
  /** L'utilisateur a choisi de se connecter sur la page Google elle-même. */
  showLogin: boolean;
}

export type Overlay = null | 'settings' | 'add-account';

export interface AppState {
  settings: Settings;
  states: Record<string, AccountState>;
  overlay: Overlay;
  version: string;
  /** Profils Chrome disponibles pour reprendre une connexion Google. */
  chromeProfiles: ChromeProfile[];
  /** Chrome est là, mais macOS refuse l'accès à ses données (Accès complet au disque). */
  chromeAccessBlocked: boolean;
}

/** Notification émise par la page Google Chat (cf. shim dans preload-account). */
export interface ChatNotificationPayload {
  id: string;
  title: string;
  body: string;
  icon: string;
  tag: string;
  silent: boolean;
}

export interface ChromeProfile {
  /** Dossier du profil (Default, Profile 1…). */
  dir: string;
  name: string;
  email: string | null;
}

/** Compte Google connecté dans un profil Chrome. */
export interface GoogleAccount {
  /** Rang dans la session Google (/u/N/). */
  index: number;
  email: string;
  name: string;
}

export interface NewAccountInput {
  name: string;
  color: string;
  url: string;
  /** true = connexion reprise depuis Chrome (écran dédié), false = page Google. */
  viaChrome?: boolean;
}

export interface ShellApi {
  getState(): Promise<AppState>;
  onState(cb: (state: AppState) => void): void;
  switchTo(id: string): void;
  addAccount(input: NewAccountInput): Promise<Account>;
  /** Comptes Google (avec e-mail) détectés dans un profil Chrome ; [] si introuvable. */
  chromeAccounts(chromeProfile: string): Promise<GoogleAccount[]>;
  /** Importe la connexion Chrome (profil + rang /u/N) dans le compte `id`. */
  importChrome(id: string, chromeProfile: string, authUser: number): Promise<boolean>;
  /** Affiche la page de connexion Google du compte. */
  showLogin(id: string): void;
  /** Ouvre le volet « Accès complet au disque » des Réglages Système. */
  openPrivacySettings(): void;
  /** Déclenche la demande d'autorisation des notifications et ouvre leur volet. */
  requestNotifications(): void;
  updateAccount(id: string, patch: Partial<Account>): void;
  removeAccount(id: string): Promise<boolean>;
  moveAccount(id: string, delta: number): void;
  reloadAccount(id: string): void;
  accountMenu(id: string): void;
  updateSettings(patch: Partial<Settings>): void;
  /** 0 = désactiver, -1 = sans limite, n = pendant n minutes. */
  setDnd(minutes: number): void;
  setOverlay(overlay: Overlay): void;
  /** Menu natif « Ne pas déranger » (au-dessus des vues Google Chat). */
  dndMenu(): void;
}
