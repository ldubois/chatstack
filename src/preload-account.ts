/**
 * Preload injecté dans chaque vue Google Chat (cadre principal et iframes).
 *
 * Google Chat publie ses alertes via l'API Web Notification et son compteur via
 * l'API Badging. On remplace ces API dans le « main world » de la page pour les
 * renvoyer vers le process principal, qui les transforme en notifications macOS
 * rattachées au bon compte et alimente le badge du Dock.
 */
import { contextBridge, ipcRenderer } from 'electron';
import type { ChatNotificationPayload } from './shared/types';

const BRIDGE = '__chatstack';

contextBridge.exposeInMainWorld(BRIDGE, {
  notify: (payload: ChatNotificationPayload) => ipcRenderer.send('account:notify', payload),
  closeNotification: (id: string) => ipcRenderer.send('account:notify-close', String(id)),
  badge: (count: number) => ipcRenderer.send('account:badge', Number(count)),
});

// Clic sur une notification macOS : on relaie vers le shim du main world, qui
// déclenche le onclick posé par Google Chat (ouverture de la conversation).
ipcRenderer.on('account:notification-click', (_event, id: string) => {
  window.postMessage({ [BRIDGE]: 'notification-click', id }, '*');
});

contextBridge.executeInMainWorld({
  func: (bridgeName: string) => {
    const bridge = (window as any)[bridgeName];
    if (!bridge || (window as any).__chatstackInstalled) return;
    (window as any).__chatstackInstalled = true;

    const live = new Map<string, any>();
    let seq = 0;

    const absolute = (url: unknown): string => {
      if (typeof url !== 'string' || !url) return '';
      try {
        return new URL(url, location.href).toString();
      } catch {
        return '';
      }
    };

    class ChatStackNotification extends EventTarget {
      static get permission(): NotificationPermission {
        return 'granted';
      }

      static requestPermission(cb?: (p: NotificationPermission) => void): Promise<NotificationPermission> {
        if (typeof cb === 'function') cb('granted');
        return Promise.resolve('granted');
      }

      static get maxActions(): number {
        return 0;
      }

      // Champs en `declare` : la fonction est sérialisée telle quelle dans la
      // page, elle ne doit dépendre d'aucun helper ajouté par le bundler.
      declare readonly title: string;
      declare readonly body: string;
      declare readonly icon: string;
      declare readonly tag: string;
      declare readonly data: unknown;
      declare readonly silent: boolean;
      declare onclick: ((ev: Event) => void) | null;
      declare onshow: ((ev: Event) => void) | null;
      declare onclose: ((ev: Event) => void) | null;
      declare onerror: ((ev: Event) => void) | null;
      declare private readonly csId: string;

      constructor(title: string, options: NotificationOptions = {}) {
        super();
        this.onclick = this.onshow = this.onclose = this.onerror = null;
        this.title = String(title ?? '');
        this.body = String(options.body ?? '');
        this.icon = absolute(options.icon);
        this.tag = String(options.tag ?? '');
        this.data = options.data ?? null;
        this.silent = Boolean(options.silent);
        this.csId = `n${++seq}-${Date.now()}`;
        live.set(this.csId, this);
        bridge.notify({
          id: this.csId,
          title: this.title,
          body: this.body,
          icon: this.icon,
          tag: this.tag,
          silent: this.silent,
        });
        setTimeout(() => this.fire('show'), 0);
      }

      close(): void {
        if (!live.delete(this.csId)) return;
        bridge.closeNotification(this.csId);
        this.fire('close');
      }

      fire(type: 'click' | 'show' | 'close'): void {
        const event = new Event(type, { cancelable: true });
        const handler = (this as any)[`on${type}`];
        if (typeof handler === 'function') {
          try {
            handler.call(this, event);
          } catch (err) {
            console.error(err);
          }
        }
        this.dispatchEvent(event);
      }
    }

    Object.defineProperty(window, 'Notification', {
      value: ChatStackNotification,
      writable: true,
      configurable: true,
    });

    // Notifications passant par le service worker : même traitement.
    if (typeof ServiceWorkerRegistration !== 'undefined') {
      ServiceWorkerRegistration.prototype.showNotification = function (title: string, options?: NotificationOptions) {
        new ChatStackNotification(title, options);
        return Promise.resolve();
      };
      ServiceWorkerRegistration.prototype.getNotifications = function () {
        return Promise.resolve([]);
      };
    }

    // API Badging : compteur de non-lus publié par l'app web.
    const nav = navigator as any;
    nav.setAppBadge = (count?: number) => {
      bridge.badge(count === undefined ? -1 : Number(count) || 0);
      return Promise.resolve();
    };
    nav.clearAppBadge = () => {
      bridge.badge(0);
      return Promise.resolve();
    };

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (event.source !== window || !msg || msg[bridgeName] !== 'notification-click') return;
      const notification = live.get(msg.id);
      if (!notification) return;
      notification.fire('click');
      live.delete(msg.id);
    });
  },
  args: [BRIDGE],
});
