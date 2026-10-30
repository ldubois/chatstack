import { session as electronSession, WebContentsView, type Session, type WebContents } from 'electron';
import path from 'node:path';
import type { Account, AccountState } from '../shared/types';
import { attachContextMenu, chromeUserAgent, isInAppUrl, isMeetUrl, openExternal, parseUrl } from './web';

const ALLOWED_PERMISSIONS = new Set([
  'notifications',
  'media',
  'clipboard-read',
  'clipboard-sanitized-write',
  'fullscreen',
  'display-capture',
  'speaker-selection',
]);

const configuredSessions = new WeakSet<Session>();

function isGoogleOrigin(url: string): boolean {
  const u = parseUrl(url);
  return !!u && u.protocol === 'https:' && /(^|\.)google\.com$/.test(u.hostname);
}

function configureSession(ses: Session): void {
  if (configuredSessions.has(ses)) return;
  configuredSessions.add(ses);
  ses.setUserAgent(chromeUserAgent());
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    callback(ALLOWED_PERMISSIONS.has(permission) && isGoogleOrigin(details.requestingUrl));
  });
  ses.setPermissionCheckHandler((_wc, permission, origin) => {
    return ALLOWED_PERMISSIONS.has(permission) && isGoogleOrigin(origin);
  });
}

export interface AccountViewHooks {
  onStateChange(): void;
  meetInBrowser(): boolean;
}

/** Une vue Google Chat isolée (cookies, stockage, cache) pour un compte. */
export class AccountView {
  readonly view: WebContentsView;
  readonly state: AccountState;
  private titleUnread = 0;
  private badgeUnread = 0;
  private retryTimer: NodeJS.Timeout | null = null;

  constructor(
    public account: Account,
    private readonly hooks: AccountViewHooks,
  ) {
    const partition = AccountView.partition(account.id);
    configureSession(electronSession.fromPartition(partition));

    this.view = new WebContentsView({
      webPreferences: {
        partition,
        preload: path.join(__dirname, 'preload-account.js'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: true,
        backgroundThrottling: false,
        spellcheck: true,
      },
    });
    this.view.setBackgroundColor('#ffffff');
    this.state = { id: account.id, unread: 0, attention: false, loading: true, crashed: false, email: null };

    this.wire(this.view.webContents);
    void this.view.webContents.loadURL(account.url);
  }

  static partition(id: string): string {
    return `persist:account-${id}`;
  }

  get webContents(): WebContents {
    return this.view.webContents;
  }

  setBadge(count: number): void {
    if (count < 0) {
      // Badge « drapeau » sans nombre : on le traite comme une alerte.
      this.state.attention = true;
    } else {
      this.badgeUnread = count;
    }
    this.recompute();
  }

  setZoom(zoom: number): void {
    this.account.zoom = Math.min(2, Math.max(0.5, Math.round(zoom * 10) / 10));
    this.webContents.setZoomFactor(this.account.zoom);
  }

  reload(): void {
    this.state.crashed = false;
    if (this.webContents.getURL()) this.webContents.reload();
    else void this.webContents.loadURL(this.account.url);
  }

  destroy(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.webContents.close();
  }

  private recompute(): void {
    this.state.unread = Math.max(this.titleUnread, this.badgeUnread);
    this.hooks.onStateChange();
  }

  private wire(wc: WebContents): void {
    attachContextMenu(wc);

    wc.on('page-title-updated', (_event, title) => {
      const count = title.match(/\((\d+)\+?\)/) ?? title.match(/^(\d+)\+?\s/);
      this.titleUnread = count ? parseInt(count[1], 10) : 0;
      const email = title.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/);
      if (email) this.state.email = email[0];
      this.recompute();
    });

    wc.on('did-start-loading', () => {
      this.state.loading = true;
      this.hooks.onStateChange();
    });
    wc.on('did-stop-loading', () => {
      this.state.loading = false;
      this.hooks.onStateChange();
    });
    wc.on('did-navigate', (_event, url) => {
      wc.setZoomFactor(this.account.zoom);
      // Non connecté : chat.google.com renvoie vers la page marketing Workspace.
      // On envoie directement sur la connexion Google, avec retour vers Chat.
      const u = parseUrl(url);
      if (u?.hostname === 'workspace.google.com') {
        void wc.loadURL(`https://accounts.google.com/ServiceLogin?continue=${encodeURIComponent(this.account.url)}`);
      }
    });

    wc.on('did-fail-load', (_event, errorCode, _desc, url, isMainFrame) => {
      // -3 = navigation annulée (redirections), pas une vraie erreur.
      if (!isMainFrame || errorCode === -3) return;
      this.scheduleRetry(url || this.account.url, 10_000);
    });

    wc.on('render-process-gone', (_event, details) => {
      if (details.reason === 'clean-exit') return;
      this.state.crashed = true;
      this.hooks.onStateChange();
      this.scheduleRetry(this.account.url, 3_000);
    });

    wc.on('will-navigate', (event, url) => {
      const u = parseUrl(url);
      if (u && (isInAppUrl(u) || u.protocol === 'about:')) return;
      event.preventDefault();
      openExternal(url);
    });

    wc.setWindowOpenHandler(({ url }) => {
      const u = parseUrl(url);
      if (u && isMeetUrl(u) && this.hooks.meetInBrowser()) {
        openExternal(url);
        return { action: 'deny' };
      }
      if (url === 'about:blank' || (u && (isInAppUrl(u) || isMeetUrl(u)))) {
        // Pop-ups Google (connexion, fenêtre de conversation détachée, Meet) : même session.
        return {
          action: 'allow',
          overrideBrowserWindowOptions: { width: 960, height: 760, autoHideMenuBar: true },
        };
      }
      openExternal(url);
      return { action: 'deny' };
    });

    wc.on('did-create-window', (child) => {
      attachContextMenu(child.webContents);
      child.webContents.setWindowOpenHandler(({ url }) => {
        openExternal(url);
        return { action: 'deny' };
      });
    });
  }

  private scheduleRetry(url: string, delay: number): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.state.crashed = false;
      void this.webContents.loadURL(url);
    }, delay);
  }
}
