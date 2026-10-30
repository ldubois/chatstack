import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { ACCOUNT_COLORS, DEFAULT_CHAT_URL, type Account, type Settings } from '../shared/types';

const DEFAULTS: Settings = {
  accounts: [],
  activeAccountId: null,
  dndUntil: 0,
  showPreview: true,
  dockBounce: 'informational',
  badgeMode: 'count',
  showTray: true,
  launchAtLogin: false,
  closeToBackground: true,
  meetInBrowser: true,
};

/** Paramètres persistés en JSON dans le dossier userData, écriture différée. */
export class SettingsStore {
  private readonly file = path.join(app.getPath('userData'), 'settings.json');
  private data: Settings;
  private writeTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.data = this.load();
  }

  get(): Settings {
    return this.data;
  }

  update(patch: Partial<Settings>): Settings {
    this.data = { ...this.data, ...patch };
    this.scheduleWrite();
    return this.data;
  }

  account(id: string): Account | undefined {
    return this.data.accounts.find((a) => a.id === id);
  }

  /** Complète un compte (nouveau ou relu du disque) avec les valeurs par défaut. */
  normalizeAccount(input: Partial<Account>, index = this.data.accounts.length): Account {
    return {
      id: input.id ?? `acc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      name: (input.name ?? '').trim() || `Compte ${index + 1}`,
      color: input.color ?? ACCOUNT_COLORS[index % ACCOUNT_COLORS.length],
      url: sanitizeUrl(input.url),
      notifications: input.notifications ?? true,
      sound: input.sound ?? true,
      includeInBadge: input.includeInBadge ?? true,
      zoom: input.zoom ?? 1,
    };
  }

  /** Écrit immédiatement (à la fermeture de l'app). */
  flush(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    } catch (err) {
      console.error('[store] écriture impossible', err);
    }
  }

  private scheduleWrite(): void {
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = setTimeout(() => this.flush(), 300);
  }

  private load(): Settings {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<Settings>;
      this.data = { ...DEFAULTS, ...raw, accounts: [] };
      this.data.accounts = (raw.accounts ?? []).map((a, i) => this.normalizeAccount(a, i));
      return this.data;
    } catch {
      return { ...DEFAULTS };
    }
  }
}

/** N'accepte que des URL https Google ; sinon URL Google Chat par défaut. */
export function sanitizeUrl(url: string | undefined): string {
  if (!url) return DEFAULT_CHAT_URL;
  try {
    const u = new URL(url.trim());
    if (u.protocol === 'https:' && isGoogleHost(u.hostname)) return u.toString();
  } catch {
    // URL invalide : on retombe sur la valeur par défaut
  }
  return DEFAULT_CHAT_URL;
}

export function isGoogleHost(hostname: string): boolean {
  return /(^|\.)(google\.com|googleusercontent\.com|gstatic\.com|youtube\.com)$/.test(hostname);
}
