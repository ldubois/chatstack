import { app, Menu, nativeImage, shell, Tray, type MenuItemConstructorOptions } from 'electron';
import { DND_FOREVER, type Account, type AccountState, type Settings } from '../shared/types';
import { assetPath } from './web';

const REPO_URL = 'https://github.com/ldubois/chatstack';

/** Ce dont les menus ont besoin du contrôleur. */
export interface MenuActions {
  settings(): Settings;
  stateOf(id: string): AccountState | undefined;
  activeId(): string | null;
  showWindow(): void;
  switchTo(id: string): void;
  switchRelative(delta: number): void;
  openSettings(): void;
  addAccount(): void;
  reloadActive(): void;
  zoomActive(delta: number | null): void;
  goBack(): void;
  goForward(): void;
  toggleDevTools(): void;
  setDnd(minutes: number): void;
}

export function dndLabel(until: number): string {
  if (until <= Date.now()) return '';
  if (until >= DND_FOREVER) return 'Ne pas déranger activé';
  const end = new Date(until);
  return `Ne pas déranger jusqu'à ${end.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
}

function minutesUntilTomorrowMorning(): number {
  const now = new Date();
  const target = new Date(now);
  target.setDate(now.getDate() + 1);
  target.setHours(8, 0, 0, 0);
  return Math.ceil((target.getTime() - now.getTime()) / 60_000);
}

export function dndItems(actions: MenuActions): MenuItemConstructorOptions[] {
  const active = actions.settings().dndUntil > Date.now();
  return [
    ...(active ? [{ label: dndLabel(actions.settings().dndUntil), enabled: false }, { label: 'Réactiver les notifications', click: () => actions.setDnd(0) }, { type: 'separator' as const }] : []),
    { label: 'Pendant 30 minutes', click: () => actions.setDnd(30) },
    { label: 'Pendant 1 heure', click: () => actions.setDnd(60) },
    { label: 'Pendant 2 heures', click: () => actions.setDnd(120) },
    { label: "Jusqu'à demain 8 h", click: () => actions.setDnd(minutesUntilTomorrowMorning()) },
    { label: "Jusqu'à réactivation", click: () => actions.setDnd(-1) },
  ];
}

function accountLabel(account: Account, state: AccountState | undefined): string {
  if (!state) return account.name;
  if (state.unread > 0) return `${account.name}  (${state.unread})`;
  return state.attention ? `${account.name}  •` : account.name;
}

export function buildAppMenu(actions: MenuActions): void {
  const { accounts } = actions.settings();
  const activeId = actions.activeId();

  const accountItems: MenuItemConstructorOptions[] = accounts.map((account, i) => ({
    label: accountLabel(account, actions.stateOf(account.id)),
    type: 'radio',
    checked: account.id === activeId,
    accelerator: i < 9 ? `CmdOrCtrl+${i + 1}` : undefined,
    click: () => actions.switchTo(account.id),
  }));

  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about', label: `À propos de ${app.name}` },
        { type: 'separator' },
        { label: 'Réglages…', accelerator: 'CmdOrCtrl+,', click: () => actions.openSettings() },
        { type: 'separator' },
        { role: 'services', label: 'Services' },
        { type: 'separator' },
        { role: 'hide', label: `Masquer ${app.name}` },
        { role: 'hideOthers', label: 'Masquer les autres' },
        { role: 'unhide', label: 'Tout afficher' },
        { type: 'separator' },
        { role: 'quit', label: `Quitter ${app.name}` },
      ],
    },
    {
      label: 'Édition',
      submenu: [
        { role: 'undo', label: 'Annuler' },
        { role: 'redo', label: 'Rétablir' },
        { type: 'separator' },
        { role: 'cut', label: 'Couper' },
        { role: 'copy', label: 'Copier' },
        { role: 'paste', label: 'Coller' },
        { role: 'pasteAndMatchStyle', label: 'Coller sans mise en forme' },
        { role: 'selectAll', label: 'Tout sélectionner' },
      ],
    },
    {
      label: 'Comptes',
      submenu: [
        ...accountItems,
        ...(accountItems.length ? [{ type: 'separator' as const }] : []),
        { label: 'Compte suivant', accelerator: 'Ctrl+Tab', click: () => actions.switchRelative(1) },
        { label: 'Compte précédent', accelerator: 'Ctrl+Shift+Tab', click: () => actions.switchRelative(-1) },
        { type: 'separator' },
        { label: 'Ajouter un compte…', accelerator: 'CmdOrCtrl+N', click: () => actions.addAccount() },
        { label: 'Ne pas déranger', submenu: dndItems(actions) },
      ],
    },
    {
      label: 'Présentation',
      submenu: [
        { label: 'Recharger', accelerator: 'CmdOrCtrl+R', click: () => actions.reloadActive() },
        { type: 'separator' },
        { label: 'Zoom avant', accelerator: 'CmdOrCtrl+Plus', click: () => actions.zoomActive(0.1) },
        { label: 'Zoom arrière', accelerator: 'CmdOrCtrl+-', click: () => actions.zoomActive(-0.1) },
        { label: 'Taille réelle', accelerator: 'CmdOrCtrl+0', click: () => actions.zoomActive(null) },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Plein écran' },
        { label: 'Outils de développement', accelerator: 'Alt+CmdOrCtrl+I', click: () => actions.toggleDevTools() },
      ],
    },
    {
      label: 'Navigation',
      submenu: [
        { label: 'Précédent', accelerator: 'CmdOrCtrl+[', click: () => actions.goBack() },
        { label: 'Suivant', accelerator: 'CmdOrCtrl+]', click: () => actions.goForward() },
      ],
    },
    {
      role: 'windowMenu',
      label: 'Fenêtre',
    },
    {
      role: 'help',
      label: 'Aide',
      submenu: [{ label: 'ChatStack sur GitHub', click: () => void shell.openExternal(REPO_URL) }],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** Icône de barre des menus : total des non-lus + accès rapide aux comptes. */
export class StatusTray {
  private tray: Tray | null = null;

  constructor(private readonly actions: MenuActions) {}

  sync(enabled: boolean, total: number, attention: boolean): void {
    if (!enabled) {
      this.tray?.destroy();
      this.tray = null;
      return;
    }
    if (!this.tray) this.create();
    const dnd = this.actions.settings().dndUntil > Date.now();
    const count = total > 0 ? String(total) : attention ? '•' : '';
    this.tray!.setTitle(`${count}${dnd ? (count ? ' ' : '') + '☾' : ''}`, { fontType: 'monospacedDigit' });
    this.tray!.setToolTip(total > 0 ? `${total} message(s) non lu(s)` : app.name);
  }

  private create(): void {
    const icon = nativeImage.createFromPath(assetPath('icons', 'trayTemplate.png'));
    icon.setTemplateImage(true);
    this.tray = new Tray(icon);
    this.tray.on('click', () => this.actions.showWindow());
    this.tray.on('right-click', () => this.tray?.popUpContextMenu(this.contextMenu()));
  }

  private contextMenu(): Menu {
    const { accounts } = this.actions.settings();
    return Menu.buildFromTemplate([
      ...accounts.map((account) => ({
        label: accountLabel(account, this.actions.stateOf(account.id)),
        click: () => {
          this.actions.showWindow();
          this.actions.switchTo(account.id);
        },
      })),
      ...(accounts.length ? [{ type: 'separator' as const }] : []),
      { label: 'Ne pas déranger', submenu: dndItems(this.actions) },
      { label: 'Réglages…', click: () => this.actions.openSettings() },
      { type: 'separator' },
      { label: `Quitter ${app.name}`, click: () => app.quit() },
    ]);
  }
}
