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
}

export type Overlay = null | 'settings' | 'add-account';

export interface AppState {
  settings: Settings;
  states: Record<string, AccountState>;
  overlay: Overlay;
  version: string;
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

export interface ShellApi {
  getState(): Promise<AppState>;
  onState(cb: (state: AppState) => void): void;
  switchTo(id: string): void;
  addAccount(input: Pick<Account, 'name' | 'color' | 'url'>): Promise<Account>;
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
