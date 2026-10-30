import {
  app,
  BaseWindow,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  screen,
  session as electronSession,
  WebContentsView,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from 'electron';
import { Notification } from 'electron';
import { execFile } from 'node:child_process';
import path from 'node:path';
import {
  DND_FOREVER,
  type Account,
  type AccountState,
  type AppState,
  type ChatNotificationPayload,
  type NewAccountInput,
  type Overlay,
  type Settings,
} from '../shared/types';
import { AccountView } from './account-view';
import { importGoogleSession, isChromeAccessBlocked, listChromeProfiles, listGoogleAccounts } from './chrome-import';
import { buildAppMenu, dndItems, StatusTray, type MenuActions } from './menus';
import { Notifier } from './notifier';
import { SettingsStore } from './store';

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

const SIDEBAR_WIDTH = 72;

export class Controller implements MenuActions {
  private readonly store = new SettingsStore();
  private readonly views = new Map<string, AccountView>();
  private readonly notifier: Notifier;
  private readonly tray: StatusTray;
  private win!: BaseWindow;  // instance concrète : BrowserWindow (pour l'icône du Dock)
  private shell!: WebContentsView;
  private overlay: Overlay = null;
  private quitting = false;
  private cookiesFlushed = false;
  private pushScheduled = false;
  private dndTimer: NodeJS.Timeout | null = null;
  private chromeProfiles = listChromeProfiles();
  private chromeAccessBlocked = isChromeAccessBlocked();

  constructor() {
    this.notifier = new Notifier({
      settings: () => this.store.get(),
      isViewing: (id) => this.isViewing(id),
      openAccount: (id) => {
        this.showWindow();
        this.switchTo(id);
      },
      markAttention: (id) => {
        const view = this.views.get(id);
        if (!view) return;
        view.state.attention = true;
        this.changed();
      },
    });
    this.tray = new StatusTray(this);
  }

  start(): void {
    this.createWindow();
    this.registerIpc();
    for (const account of this.store.get().accounts) this.mountAccount(account);

    const { accounts, activeAccountId } = this.store.get();
    const initial = accounts.find((a) => a.id === activeAccountId) ?? accounts[0];
    if (initial) this.switchTo(initial.id);
    else this.setOverlay('add-account');

    this.applyLoginItem();
    this.armDndTimer();
    this.changed();


    app.on('before-quit', (event) => {
      this.quitting = true;
      this.saveBounds();
      this.store.flush();
      // Google fait tourner ses cookies de session toutes les ~10 min ; sans écriture
      // sur disque avant de quitter, on repart au lancement suivant avec une copie
      // périmée que Google refuse → compte déconnecté.
      if (this.cookiesFlushed) return;
      event.preventDefault();
      const flushes = [...this.views.keys()].map((id) => electronSession.fromPartition(AccountView.partition(id)).cookies.flushStore());
      void Promise.race([Promise.allSettled(flushes), new Promise((r) => setTimeout(r, 2_000))]).then(() => {
        this.cookiesFlushed = true;
        app.quit();
      });
    });
    app.on('activate', () => this.showWindow());
  }

  // ---------------------------------------------------------------- MenuActions

  settings(): Settings {
    return this.store.get();
  }

  stateOf(id: string): AccountState | undefined {
    return this.views.get(id)?.state;
  }

  activeId(): string | null {
    return this.store.get().activeAccountId;
  }

  showWindow(): void {
    if (this.win.isMinimized()) this.win.restore();
    this.win.show();
    this.win.focus();
    app.focus({ steal: true });
  }

  switchTo(id: string): void {
    if (!this.views.has(id)) return;
    this.store.update({ activeAccountId: id });
    this.overlay = null;
    this.layout();
    this.views.get(id)!.webContents.focus();
    this.clearAttentionIfViewing();
    this.changed();
  }

  switchRelative(delta: number): void {
    const { accounts, activeAccountId } = this.store.get();
    if (!accounts.length) return;
    const index = accounts.findIndex((a) => a.id === activeAccountId);
    const next = accounts[(index + delta + accounts.length) % accounts.length];
    this.switchTo(next.id);
  }

  openSettings(): void {
    this.showWindow();
    this.setOverlay('settings');
  }

  addAccount(): void {
    this.showWindow();
    this.setOverlay('add-account');
  }

  reloadActive(): void {
    this.activeView()?.reload();
  }

  zoomActive(delta: number | null): void {
    const view = this.activeView();
    if (!view) return;
    view.setZoom(delta === null ? 1 : view.account.zoom + delta);
    this.store.update({ accounts: [...this.store.get().accounts] });
  }

  goBack(): void {
    const history = this.activeView()?.webContents.navigationHistory;
    if (history?.canGoBack()) history.goBack();
  }

  goForward(): void {
    const history = this.activeView()?.webContents.navigationHistory;
    if (history?.canGoForward()) history.goForward();
  }

  toggleDevTools(): void {
    const target = this.overlay || !this.activeView() ? this.shell.webContents : this.activeView()!.webContents;
    target.toggleDevTools();
  }

  setDnd(minutes: number): void {
    const until = minutes === 0 ? 0 : minutes < 0 ? DND_FOREVER : Date.now() + minutes * 60_000;
    this.store.update({ dndUntil: until });
    this.armDndTimer();
    this.changed();
  }

  // ---------------------------------------------------------------- Fenêtre

  private createWindow(): void {
    const bounds = this.restoredBounds();
    // BrowserWindow (et non BaseWindow) : une app dont la seule fenêtre est une
    // BaseWindow n'obtient pas d'icône dans le Dock sur macOS. On garde l'UI dans
    // des WebContentsView enfants ; la webContents racine reste vide, masquée.
    this.win = new BrowserWindow({
      ...bounds,
      minWidth: 640,
      minHeight: 480,
      title: app.name,
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 10, y: 16 },
      backgroundColor: '#1f2937',
      show: false,
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
    });

    this.shell = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, 'preload-shell.js'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    this.shell.setBackgroundColor('#00000000');
    this.win.contentView.addChildView(this.shell);
    this.shell.webContents.on('will-navigate', (event) => event.preventDefault());
    this.shell.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.shell.webContents.once('did-finish-load', () => this.win.show());

    if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
      void this.shell.webContents.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
    } else {
      void this.shell.webContents.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
    }

    this.win.on('resize', () => this.layout());
    this.win.on('focus', () => {
      this.clearAttentionIfViewing();
      this.changed();
    });
    this.win.on('close', (event) => {
      this.saveBounds();
      if (this.quitting) return;
      if (!this.store.get().closeToBackground) {
        app.quit();
        return;
      }
      // On garde l'app (et les comptes) en vie pour continuer à recevoir les alertes.
      event.preventDefault();
      if (this.win.isFullScreen()) {
        this.win.once('leave-full-screen', () => this.win.hide());
        this.win.setFullScreen(false);
      } else {
        this.win.hide();
      }
    });
    this.layout();
  }

  private restoredBounds(): { x?: number; y?: number; width: number; height: number } {
    const saved = this.store.get().windowBounds;
    if (saved) {
      const visible = screen.getAllDisplays().some((d) => {
        const a = d.workArea;
        return saved.x < a.x + a.width && saved.x + saved.width > a.x && saved.y < a.y + a.height && saved.y + saved.height > a.y;
      });
      if (visible) return saved;
    }
    return { width: 1280, height: 860 };
  }

  private saveBounds(): void {
    if (!this.win || this.win.isDestroyed() || this.win.isFullScreen() || this.win.isMinimized()) return;
    this.store.update({ windowBounds: this.win.getNormalBounds() });
  }

  private layout(): void {
    const { width, height } = this.win.getContentBounds();
    this.shell.setBounds({ x: 0, y: 0, width, height });
    const activeId = this.store.get().activeAccountId;
    for (const [id, view] of this.views) {
      view.view.setBounds({ x: SIDEBAR_WIDTH, y: 0, width: Math.max(0, width - SIDEBAR_WIDTH), height });
      // Compte non connecté : on affiche l'écran de connexion ChatStack (import Chrome) à la place de Google.
      const waitingForChoice = view.state.signedOut && !view.state.showLogin;
      view.view.setVisible(this.overlay === null && id === activeId && !waitingForChoice);
    }
  }

  private setOverlay(overlay: Overlay): void {
    if (overlay === 'add-account' || overlay === 'settings' || overlay === null) {
      this.overlay = overlay === null && this.views.size === 0 ? 'add-account' : overlay;
      if (this.overlay === 'add-account') this.reloadChromeProfiles();
      this.layout();
      if (this.overlay) this.shell.webContents.focus();
      else this.activeView()?.webContents.focus();
      this.changed();
    }
  }

  // ---------------------------------------------------------------- Comptes

  private activeView(): AccountView | undefined {
    const id = this.store.get().activeAccountId;
    return id ? this.views.get(id) : undefined;
  }

  private mountAccount(account: Account): AccountView {
    const view = new AccountView(account, {
      onStateChange: () => this.changed(),
      meetInBrowser: () => this.store.get().meetInBrowser,
    });
    view.view.setVisible(false);
    this.win.contentView.addChildView(view.view);
    this.views.set(account.id, view);
    this.layout();
    return view;
  }

  private viewForSender(event: IpcMainEvent): AccountView | undefined {
    for (const view of this.views.values()) {
      if (view.webContents === event.sender) return view;
    }
    return undefined;
  }

  private isViewing(id: string): boolean {
    return this.win.isVisible() && this.win.isFocused() && this.overlay === null && this.store.get().activeAccountId === id;
  }

  private clearAttentionIfViewing(): void {
    const view = this.activeView();
    if (view && this.isViewing(view.account.id) && view.state.attention) {
      view.state.attention = false;
      this.notifier.clearAccount(view.account.id);
    }
  }

  private async removeAccount(id: string): Promise<boolean> {
    const view = this.views.get(id);
    if (!view) return false;
    const { response } = await dialog.showMessageBox(this.win, {
      type: 'warning',
      buttons: ['Supprimer', 'Annuler'],
      defaultId: 1,
      cancelId: 1,
      message: `Supprimer le compte « ${view.account.name} » ?`,
      detail: 'La connexion Google et les données de ce compte seront effacées de ce Mac.',
    });
    if (response !== 0) return false;

    this.notifier.clearAccount(id);
    this.win.contentView.removeChildView(view.view);
    view.destroy();
    this.views.delete(id);
    const ses = electronSession.fromPartition(AccountView.partition(id));
    await ses.clearStorageData();
    await ses.clearCache();

    const accounts = this.store.get().accounts.filter((a) => a.id !== id);
    const activeAccountId = this.store.get().activeAccountId === id ? (accounts[0]?.id ?? null) : this.store.get().activeAccountId;
    this.store.update({ accounts, activeAccountId });
    if (activeAccountId) this.switchTo(activeAccountId);
    else this.setOverlay('add-account');
    return true;
  }

  // ---------------------------------------------------------------- IPC

  private registerIpc(): void {
    const fromShell = (event: IpcMainEvent | IpcMainInvokeEvent) => event.sender === this.shell.webContents;

    ipcMain.handle('shell:get-state', (event) => (fromShell(event) ? this.snapshot() : null));

    ipcMain.on('shell:switch', (event, id: string) => {
      if (fromShell(event)) this.switchTo(String(id));
    });

    ipcMain.handle('shell:add-account', async (event, input: NewAccountInput) => {
      if (!fromShell(event)) return null;
      const account = this.store.normalizeAccount({ name: input.name, color: input.color, url: input.url });
      this.store.update({ accounts: [...this.store.get().accounts, account] });
      const view = this.mountAccount(account);
      // Connexion manuelle : page Google directement ; sinon écran « Connecter » (import Chrome).
      view.state.showLogin = !input.viaChrome;
      this.switchTo(account.id);
      return account;
    });

    ipcMain.handle('shell:chrome-accounts', async (event, chromeProfile: string) => {
      if (!fromShell(event)) return [];
      try {
        return listGoogleAccounts(String(chromeProfile));
      } catch (err) {
        await this.importError(err);
        return [];
      }
    });

    ipcMain.handle('shell:import-chrome', async (event, id: string, chromeProfile: string, authUser: number) => {
      const view = fromShell(event) ? this.views.get(String(id)) : undefined;
      if (!view) return false;
      const rank = Math.max(0, Math.min(9, Math.trunc(Number(authUser)) || 0));
      if (!(await this.importFromChrome(view.account, String(chromeProfile)))) return false;
      view.account.url = `https://chat.google.com/u/${rank}/`;
      this.store.update({ accounts: [...this.store.get().accounts] });
      view.state.showLogin = true; // on affiche la page (Chat ou, si l'import a raté, la connexion)
      void view.webContents.loadURL(view.account.url);
      this.changed();
      return true;
    });

    ipcMain.on('shell:request-notifications', (event) => {
      if (!fromShell(event)) return;
      // Afficher une notification force l'enregistrement de l'app et la demande
      // d'autorisation ; on ouvre ensuite le volet Notifications des Réglages.
      if (Notification.isSupported()) {
        try {
          new Notification({ title: 'ChatStack', body: 'Notifications activées.', silent: true }).show();
        } catch {
          // ignore
        }
      }
      execFile('/usr/bin/open', ['x-apple.systempreferences:com.apple.Notifications-Settings.extension'], (err) => {
        if (err) console.error('[notif] ouverture des réglages impossible', err);
      });
    });

    ipcMain.on('shell:open-privacy', (event) => {
      if (!fromShell(event)) return;
      // Via /usr/bin/open (Launch Services), pas shell.openExternal : sur certaines
      // versions de macOS ce schéma est sinon renvoyé au navigateur par défaut.
      execFile('/usr/bin/open', ['x-apple.systempreferences:com.apple.preference.security?Privacy_AllFilesAccess'], (err) => {
        if (err) console.error('[privacy] ouverture des réglages impossible', err);
      });
    });

    ipcMain.on('shell:show-login', (event, id: string) => {
      const view = fromShell(event) ? this.views.get(String(id)) : undefined;
      if (!view) return;
      view.state.showLogin = true;
      this.changed();
    });


    ipcMain.on('shell:update-account', (event, id: string, patch: Partial<Account>) => {
      if (!fromShell(event)) return;
      const view = this.views.get(id);
      if (!view) return;
      const current = view.account;
      const next = this.store.normalizeAccount({ ...current, ...patch, id: current.id });
      Object.assign(current, next);
      if (patch.url !== undefined && next.url !== view.webContents.getURL()) void view.webContents.loadURL(next.url);
      if (patch.zoom !== undefined) view.setZoom(next.zoom);
      this.store.update({ accounts: this.store.get().accounts.map((a) => (a.id === id ? current : a)) });
      this.changed();
    });

    ipcMain.handle('shell:remove-account', (event, id: string) => (fromShell(event) ? this.removeAccount(String(id)) : false));

    ipcMain.on('shell:move-account', (event, id: string, delta: number) => {
      if (!fromShell(event)) return;
      const accounts = [...this.store.get().accounts];
      const from = accounts.findIndex((a) => a.id === id);
      const to = from + Math.sign(delta);
      if (from < 0 || to < 0 || to >= accounts.length) return;
      [accounts[from], accounts[to]] = [accounts[to], accounts[from]];
      this.store.update({ accounts });
      this.changed();
    });

    ipcMain.on('shell:reload-account', (event, id: string) => {
      if (fromShell(event)) this.views.get(id)?.reload();
    });

    ipcMain.on('shell:account-menu', (event, id: string) => {
      if (fromShell(event)) this.popupAccountMenu(String(id));
    });

    ipcMain.on('shell:update-settings', (event, patch: Partial<Settings>) => {
      if (!fromShell(event)) return;
      const allowed: (keyof Settings)[] = ['showPreview', 'dockBounce', 'badgeMode', 'showTray', 'launchAtLogin', 'closeToBackground', 'meetInBrowser'];
      const clean = Object.fromEntries(Object.entries(patch).filter(([k]) => allowed.includes(k as keyof Settings)));
      this.store.update(clean);
      if ('launchAtLogin' in clean) this.applyLoginItem();
      this.changed();
    });

    ipcMain.on('shell:set-dnd', (event, minutes: number) => {
      if (fromShell(event)) this.setDnd(Number(minutes) || 0);
    });

    ipcMain.on('shell:set-overlay', (event, overlay: Overlay) => {
      if (fromShell(event)) this.setOverlay(overlay);
    });

    ipcMain.on('shell:dnd-menu', (event) => {
      if (fromShell(event)) Menu.buildFromTemplate(dndItems(this)).popup({ window: this.win });
    });

    // Messages venant des pages Google Chat (cf. preload-account)
    ipcMain.on('account:notify', (event, payload: ChatNotificationPayload) => {
      const view = this.viewForSender(event);
      if (!view || !payload || typeof payload.id !== 'string') return;
      void this.notifier.show(view, sanitizePayload(payload), event.senderFrame).then((shown) => {
        if (shown) this.bounceDock();
      });
    });

    ipcMain.on('account:notify-close', (event, id: string) => {
      const view = this.viewForSender(event);
      if (view) this.notifier.close(view.account, String(id));
    });

    ipcMain.on('account:badge', (event, count: number) => {
      const view = this.viewForSender(event);
      if (view && Number.isFinite(count)) view.setBadge(Math.trunc(count));
    });
  }

  /** Importe la connexion Google d'un profil Chrome ; en cas d'échec, on retombe sur la connexion manuelle. */
  private async importFromChrome(account: Account, profileDir: string): Promise<boolean> {
    try {
      await importGoogleSession(profileDir, electronSession.fromPartition(AccountView.partition(account.id)));
      return true;
    } catch (err) {
      await this.importError(err);
      return false;
    }
  }

  private async importError(err: unknown): Promise<void> {
    await dialog.showMessageBox(this.win, {
      type: 'warning',
      message: 'Import depuis Chrome impossible',
      detail: `${err instanceof Error ? err.message : String(err)}\n\nTu peux te connecter directement dans ChatStack.`,
    });
  }

  /** Relit les profils Chrome ; on garde la dernière liste connue si la lecture échoue. */
  private reloadChromeProfiles(): void {
    const profiles = listChromeProfiles();
    if (profiles.length) this.chromeProfiles = profiles;
    this.chromeAccessBlocked = profiles.length === 0 && isChromeAccessBlocked();
  }

  /** Clique tous les boutons « Marquer comme lu » des conversations de Google Chat. */
  /** Clique tous les boutons « Marquer comme lu » visibles (plusieurs passes :
   *  Google Chat ne rend que les conversations visibles, la liste se met à jour). */
  private markAllRead(view: AccountView): void {
    const js = `(() => {
      const SEL = '[aria-label="Marquer comme lu"], [aria-label="Mark as read"], [data-tooltip="Marquer comme lu"], [data-tooltip="Mark as read"]';
      let pass = 0;
      const run = () => {
        document.querySelectorAll(SEL).forEach((b) => { try { b.click(); } catch (e) {} });
        if (++pass < 10) setTimeout(run, 500);
      };
      run();
    })()`;
    view.webContents.executeJavaScript(js).catch(() => undefined);
  }

  /**
   * Repart d'une session Google vierge, propre à ChatStack. Une session importée de
   * Chrome partage ses cookies avec Chrome : dès que l'un des deux les fait tourner
   * (__Secure-1PSIDTS, DBSC), Google invalide l'autre copie → déconnexions répétées.
   */
  private async reconnect(id: string): Promise<void> {
    const view = this.views.get(id);
    if (!view) return;
    const { response } = await dialog.showMessageBox(this.win, {
      type: 'question',
      buttons: ['Se reconnecter', 'Annuler'],
      defaultId: 0,
      cancelId: 1,
      message: `Reconnecter « ${view.account.name} » ?`,
      detail:
        'La session actuelle est effacée et la page de connexion Google s’ouvre. ' +
        'Connectez-vous avec l’e-mail de ce compte uniquement : la session sera propre à ChatStack, indépendante de Chrome.',
    });
    if (response !== 0) return;

    await electronSession.fromPartition(AccountView.partition(id)).clearStorageData();
    // Session vierge = un seul compte Google connecté → toujours /u/0/.
    view.account.url = 'https://chat.google.com/u/0/';
    this.store.update({ accounts: [...this.store.get().accounts] });
    view.state.showLogin = true;
    void view.webContents.loadURL(`https://accounts.google.com/ServiceLogin?continue=${encodeURIComponent(view.account.url)}`);
    this.switchTo(id);
    this.changed();
  }

  private popupAccountMenu(id: string): void {
    const view = this.views.get(id);
    if (!view) return;
    Menu.buildFromTemplate([
      { label: 'Marquer tout comme lu', click: () => this.markAllRead(view) },
      { label: 'Recharger', click: () => view.reload() },
      { label: 'Se reconnecter…', click: () => void this.reconnect(id) },
      {
        label: 'Notifications',
        type: 'checkbox',
        checked: view.account.notifications,
        click: (item) => {
          view.account.notifications = item.checked;
          this.store.update({ accounts: [...this.store.get().accounts] });
          this.changed();
        },
      },
      { type: 'separator' },
      { label: 'Modifier…', click: () => this.openSettings() },
      { label: 'Supprimer…', click: () => void this.removeAccount(id) },
    ]).popup({ window: this.win });
  }

  // ---------------------------------------------------------------- Badge, Dock, état

  private bounceDock(): void {
    const { dockBounce } = this.store.get();
    if (dockBounce === 'none' || this.notifier.isDndActive() || this.win.isFocused()) return;
    app.dock?.bounce(dockBounce);
  }

  private armDndTimer(): void {
    if (this.dndTimer) clearTimeout(this.dndTimer);
    const remaining = this.store.get().dndUntil - Date.now();
    if (remaining > 0 && remaining < 2 ** 31 - 1) {
      this.dndTimer = setTimeout(() => {
        this.store.update({ dndUntil: 0 });
        this.changed();
      }, remaining);
    }
  }

  private applyLoginItem(): void {
    const wanted = this.store.get().launchAtLogin;
    if (!app.isPackaged || app.getLoginItemSettings().openAtLogin === wanted) return;
    app.setLoginItemSettings({ openAtLogin: wanted });
  }

  private snapshot(): AppState {
    const states: Record<string, AccountState> = {};
    for (const [id, view] of this.views) states[id] = { ...view.state };
    return {
      settings: this.store.get(),
      states,
      overlay: this.overlay,
      version: app.getVersion(),
      chromeProfiles: this.chromeProfiles,
      chromeAccessBlocked: this.chromeAccessBlocked,
    };
  }

  /** Regroupe les mises à jour (badge, menus, sidebar) en un seul passage. */
  private changed(): void {
    if (this.pushScheduled) return;
    this.pushScheduled = true;
    setImmediate(() => {
      this.pushScheduled = false;
      this.refresh();
    });
  }

  private refresh(): void {
    this.layout();
    const settings = this.store.get();
    let total = 0;
    let attention = false;
    for (const account of settings.accounts) {
      const state = this.views.get(account.id)?.state;
      if (!state || !account.includeInBadge) continue;
      total += state.unread;
      attention ||= state.attention;
    }

    let badge = '';
    if (settings.badgeMode === 'count') badge = total > 0 ? String(total) : attention ? '•' : '';
    else if (settings.badgeMode === 'dot') badge = total > 0 || attention ? '•' : '';
    app.dock?.setBadge(badge);

    this.tray.sync(settings.showTray, total, attention);
    buildAppMenu(this);
    if (!this.shell.webContents.isDestroyed()) this.shell.webContents.send('shell:state', this.snapshot());
  }
}

function sanitizePayload(p: ChatNotificationPayload): ChatNotificationPayload {
  const str = (v: unknown, max: number) => String(v ?? '').slice(0, max);
  return {
    id: str(p.id, 100),
    title: str(p.title, 200),
    body: str(p.body, 1000),
    icon: str(p.icon, 2000),
    tag: str(p.tag, 200),
    silent: Boolean(p.silent),
  };
}
