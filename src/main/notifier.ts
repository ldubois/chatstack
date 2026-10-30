import { Notification, nativeImage, type NativeImage, type WebFrameMain } from 'electron';
import type { Account, ChatNotificationPayload, Settings } from '../shared/types';
import type { AccountView } from './account-view';
import { parseUrl } from './web';

export interface NotifierHooks {
  settings(): Settings;
  /** Le compte est affiché au premier plan (fenêtre active, pas de panneau ouvert). */
  isViewing(accountId: string): boolean;
  openAccount(accountId: string): void;
  markAttention(accountId: string): void;
}

interface Shown {
  notification: Notification;
  accountId: string;
  tag: string;
}

/** Transforme les notifications web de Google Chat en notifications macOS. */
export class Notifier {
  // Référence conservée : une Notification ramassée par le GC perd ses événements.
  private readonly shown = new Map<string, Shown>();

  constructor(private readonly hooks: NotifierHooks) {}

  isDndActive(): boolean {
    return this.hooks.settings().dndUntil > Date.now();
  }

  /** Retourne true si une notification macOS a été affichée. */
  async show(view: AccountView, payload: ChatNotificationPayload, frame: WebFrameMain | null): Promise<boolean> {
    const account = view.account;
    if (this.hooks.isViewing(account.id)) return false;

    this.hooks.markAttention(account.id);
    if (!account.notifications || this.isDndActive() || !Notification.isSupported()) return false;

    const key = `${account.id}:${payload.id}`;
    if (payload.tag) this.closeTag(account.id, payload.tag);

    const settings = this.hooks.settings();
    const notification = new Notification({
      title: payload.title || account.name,
      subtitle: account.name,
      body: settings.showPreview ? payload.body : 'Nouveau message',
      silent: !account.sound || payload.silent,
      icon: await this.loadIcon(view, payload.icon),
    });

    notification.on('click', () => {
      this.hooks.openAccount(account.id);
      if (frame && !frame.isDestroyed()) frame.send('account:notification-click', payload.id);
      this.shown.delete(key);
    });
    notification.on('close', () => this.shown.delete(key));

    this.shown.set(key, { notification, accountId: account.id, tag: payload.tag });
    notification.show();
    return true;
  }

  close(account: Account, id: string): void {
    const key = `${account.id}:${id}`;
    this.shown.get(key)?.notification.close();
    this.shown.delete(key);
  }

  /** Retire du centre de notifications les alertes d'un compte qu'on vient d'ouvrir. */
  clearAccount(accountId: string): void {
    for (const [key, entry] of this.shown) {
      if (entry.accountId !== accountId) continue;
      entry.notification.close();
      this.shown.delete(key);
    }
  }

  private closeTag(accountId: string, tag: string): void {
    for (const [key, entry] of this.shown) {
      if (entry.accountId === accountId && entry.tag === tag) {
        entry.notification.close();
        this.shown.delete(key);
      }
    }
  }

  /** Avatar de l'expéditeur, téléchargé avec la session du compte (cookies Google). */
  private async loadIcon(view: AccountView, url: string): Promise<NativeImage | undefined> {
    const u = parseUrl(url);
    if (!u || u.protocol !== 'https:' || !/(^|\.)(google\.com|googleusercontent\.com|gstatic\.com)$/.test(u.hostname)) {
      return undefined;
    }
    try {
      const res = await view.webContents.session.fetch(u.toString(), { signal: AbortSignal.timeout(2500) });
      if (!res.ok) return undefined;
      const image = nativeImage.createFromBuffer(Buffer.from(await res.arrayBuffer()));
      return image.isEmpty() ? undefined : image;
    } catch {
      return undefined;
    }
  }
}
