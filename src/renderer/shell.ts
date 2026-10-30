import './shell.css';
import { ACCOUNT_COLORS, DEFAULT_CHAT_URL, DND_FOREVER, type Account, type AppState, type ChromeProfile, type GoogleAccount } from '../shared/types';

const api = window.chatstack;
const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

let state: AppState | null = null;
let renderedSignature = '';
let pendingRender = false;
let chromeProfiles: ChromeProfile[] = [];
let chromeAccessBlocked = false;

// ------------------------------------------------------------------ helpers

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, any> = {},
  ...children: (Node | string | null | false)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'class') el.className = value;
    else if (key === 'style') el.setAttribute('style', value);
    else if (key in el) (el as any)[key] = value;
    else el.setAttribute(key, String(value));
  }
  for (const child of children) {
    if (child === null || child === false) continue;
    el.append(child);
  }
  return el;
}

function initials(name: string): string {
  const words = name.trim().split(/[\s@._-]+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

function dndActive(): boolean {
  return !!state && state.settings.dndUntil > Date.now();
}

function dndText(): string {
  if (!state || !dndActive()) return 'Notifications actives';
  if (state.settings.dndUntil >= DND_FOREVER) return 'Ne pas déranger — jusqu’à réactivation';
  const t = new Date(state.settings.dndUntil).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  return `Ne pas déranger — jusqu’à ${t}`;
}

function toggle(checked: boolean, onChange: (v: boolean) => void, label?: string): HTMLLabelElement {
  return h(
    'label',
    { class: 'toggle', title: label },
    h('input', { type: 'checkbox', checked, onchange: (e: Event) => onChange((e.target as HTMLInputElement).checked) }),
    h('span', { class: 'track' }),
  );
}

function select<T extends string>(value: T, options: [T, string][], onChange: (v: T) => void): HTMLSelectElement {
  const el = h('select', { onchange: (e: Event) => onChange((e.target as HTMLSelectElement).value as T) });
  for (const [v, label] of options) el.append(h('option', { value: v, selected: v === value }, label));
  return el;
}

function row(title: string, hint: string, control: HTMLElement): HTMLElement {
  return h('div', { class: 'row' }, h('div', { class: 'row-text' }, h('div', { class: 'row-title' }, title), hint ? h('div', { class: 'row-hint' }, hint) : null), control);
}

// ------------------------------------------------------------------ sidebar

function renderSidebar(): void {
  if (!state) return;
  const nav = $('#accounts');
  nav.replaceChildren();
  const { accounts, activeAccountId } = state.settings;

  accounts.forEach((account, i) => {
    const s = state!.states[account.id];
    const active = account.id === activeAccountId && state!.overlay === null;
    const badge = s && s.unread > 0 ? h('span', { class: 'badge' }, s.unread > 99 ? '99+' : String(s.unread)) : s?.attention ? h('span', { class: 'dot' }) : null;
    const tooltip = [account.name, s?.email, i < 9 ? `⌘${i + 1}` : ''].filter(Boolean).join(' — ');

    nav.append(
      h(
        'button',
        {
          class: `account${active ? ' active' : ''}${s?.loading ? ' loading' : ''}${s?.crashed ? ' crashed' : ''}${account.notifications ? '' : ' muted'}`,
          title: tooltip,
          onclick: () => api.switchTo(account.id),
          oncontextmenu: (e: Event) => {
            e.preventDefault();
            api.accountMenu(account.id);
          },
        },
        h('span', { class: 'avatar', style: `--c:${account.color}` }, initials(account.name)),
        badge,
      ),
    );
  });

  $('#dnd').classList.toggle('on', dndActive());
  $('#dnd').title = dndText();
  $('#settings').classList.toggle('on', state.overlay === 'settings');
  $('#add').classList.toggle('on', state.overlay === 'add-account');
}

// ------------------------------------------------------------------ add account

function renderAddAccount(): HTMLElement {
  const first = state!.settings.accounts.length === 0;
  let color = ACCOUNT_COLORS[state!.settings.accounts.length % ACCOUNT_COLORS.length];

  const name = h('input', { type: 'text', placeholder: 'Ex. Perso, Pro, Asso…', maxLength: 40, autofocus: true });
  const url = h('input', { type: 'url', value: DEFAULT_CHAT_URL, spellcheck: false });
  const swatches = h('div', { class: 'swatches' });
  const paint = () => {
    swatches.replaceChildren(
      ...ACCOUNT_COLORS.map((c) =>
        h('button', {
          type: 'button',
          class: `swatch${c === color ? ' selected' : ''}`,
          style: `--c:${c}`,
          title: c,
          onclick: (e: Event) => {
            e.preventDefault();
            color = c;
            paint();
          },
        }),
      ),
    );
  };
  paint();

  // Source de connexion : reprise de Chrome (écran « Connecter » ensuite) ou page Google.
  const chromeAvailable = chromeProfiles.length > 0;
  const useChrome = h('input', { type: 'radio', name: 'source', checked: chromeAvailable, disabled: !chromeAvailable });
  const useLogin = h('input', { type: 'radio', name: 'source', checked: !chromeAvailable });
  const chromeHint = chromeAvailable
    ? 'Tu choisis ensuite parmi les comptes Google de ton Chrome.'
    : chromeAccessBlocked
      ? 'Accès aux données de Chrome bloqué par macOS (voir ci-dessous).'
      : 'Aucun profil Chrome trouvé sur ce Mac.';
  const source = h(
    'div',
    { class: 'field' },
    h('span', {}, 'Connexion'),
    h('label', { class: `source${chromeAvailable ? '' : ' disabled'}` }, useChrome, h('div', {}, h('b', {}, 'Reprendre ma connexion Chrome'), h('small', {}, chromeHint))),
    h('label', { class: 'source' }, useLogin, h('div', {}, h('b', {}, 'Me connecter dans ChatStack'), h('small', {}, 'Page de connexion Google classique.'))),
    !chromeAvailable && chromeAccessBlocked ? accessBanner() : null,
  );

  const submitBtn = h('button', { type: 'submit', class: 'btn primary' }, 'Ajouter le compte');
  const submit = async (e: Event) => {
    e.preventDefault();
    submitBtn.disabled = true;
    try {
      await api.addAccount({ name: name.value, color, url: url.value, viaChrome: useChrome.checked });
    } finally {
      submitBtn.disabled = false;
    }
  };

  return h(
    'div',
    { class: 'panel narrow' },
    first
      ? h('div', { class: 'hero' }, h('div', { class: 'logo' }), h('h1', {}, 'Bienvenue dans ChatStack'), h('p', {}, 'Tous tes comptes Google Chat dans une seule app, avec notifications natives et badge dans le Dock.'))
      : h('h1', {}, 'Ajouter un compte'),
    h(
      'form',
      { class: 'card', onsubmit: submit },
      h('label', { class: 'field' }, h('span', {}, 'Nom du compte'), name),
      h('div', { class: 'field' }, h('span', {}, 'Couleur'), swatches),
      source,
      h('details', {}, h('summary', {}, 'Options avancées'), h('label', { class: 'field' }, h('span', {}, 'Adresse Google Chat'), url), h('p', { class: 'hint' }, 'Par défaut chat.google.com. Tu peux mettre https://mail.google.com/chat/ pour l’interface intégrée à Gmail.')),
      h(
        'div',
        { class: 'actions' },
        first ? null : h('button', { type: 'button', class: 'btn ghost', onclick: () => api.setOverlay(null) }, 'Annuler'),
        submitBtn,
      ),
      h('p', { class: 'hint' }, 'Chaque compte a sa propre session isolée : cookies, stockage et cache ne sont jamais partagés.'),
    ),
  );
}

// ------------------------------------------------------------------ accès Chrome bloqué

function accessBanner(): HTMLElement {
  return h(
    'div',
    { class: 'notice' },
    h('b', {}, 'ChatStack n’a pas accès aux données de Chrome'),
    h('p', {}, 'macOS protège les données de Chrome. Pour reprendre ta connexion Google, autorise ChatStack une fois :'),
    h(
      'ol',
      { class: 'steps' },
      h('li', {}, 'Clique sur le bouton ci-dessous (ouvre « Confidentialité et sécurité »).'),
      h('li', {}, 'Ouvre ', h('b', {}, 'Accès complet au disque'), '.'),
      h('li', {}, 'Clique sur ', h('b', {}, '+'), ', choisis ', h('b', {}, 'ChatStack'), ', et active l’interrupteur.'),
      h('li', {}, 'Quitte ChatStack (⌘Q) et rouvre-le.'),
    ),
    h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: () => api.openPrivacySettings() }, 'Ouvrir les réglages de confidentialité')),
    h('p', { class: 'hint' }, 'Tu préfères éviter cette autorisation ? « Me connecter dans ChatStack » fonctionne sans elle (connexion Google une seule fois, puis conservée).'),
  );
}

// ------------------------------------------------------------------ compte non connecté

/** Comptes Google détectés, conservés entre deux rendus de l'écran de connexion. */
let found: { profile: string; accounts: GoogleAccount[] } | null = null;
let searching = false;

function renderConnect(account: Account): HTMLElement {
  const profileSelect = h('select', {});
  for (const p of chromeProfiles) {
    profileSelect.append(h('option', { value: p.dir, selected: p.dir === found?.profile }, p.email ? `${p.name} — ${p.email}` : p.name));
  }

  const search = async () => {
    searching = true;
    renderContent(true);
    try {
      const accounts = await api.chromeAccounts(profileSelect.value);
      found = { profile: profileSelect.value, accounts };
    } finally {
      searching = false;
      renderContent(true);
    }
  };

  const importRank = async (rank: number) => {
    await api.importChrome(account.id, (found?.profile ?? profileSelect.value), rank);
  };

  let card: HTMLElement;
  if (found && found.accounts.length) {
    // Comptes trouvés : une ligne par e-mail, bouton « Connecter » par compte.
    card = h(
      'div',
      { class: 'card form' },
      h('div', { class: 'field' }, h('span', {}, 'Comptes Google de ton Chrome')),
      ...found.accounts.map((g) => {
        const btn = h('button', { class: 'btn primary small' }, 'Connecter');
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          btn.textContent = 'Import…';
          try {
            await importRank(g.index);
          } finally {
            btn.disabled = false;
            btn.textContent = 'Connecter';
          }
        });
        return h('div', { class: 'acc-pick' }, h('span', { class: 'avatar tiny', style: `--c:${account.color}` }, g.email[0].toUpperCase()), h('div', { class: 'pick-mail' }, g.email), btn);
      }),
      h('p', { class: 'hint' }, 'Un clic sur « Connecter » ouvre Google Chat de ce compte, déjà connecté. Pour en ajouter un autre, reviens au + ensuite.'),
    );
  } else if (found) {
    // Recherche faite mais aucun e-mail détecté : repli sur le rang.
    const ranks = ['Compte principal', '2ᵉ compte du profil', '3ᵉ compte du profil', '4ᵉ compte du profil', '5ᵉ compte du profil'];
    const rankSelect = select('0', ranks.map((l, i) => [String(i), l] as [string, string]), () => undefined);
    const importBtn = h('button', { class: 'btn primary' }, 'Importer et ouvrir Google Chat');
    importBtn.addEventListener('click', async () => {
      importBtn.disabled = true;
      importBtn.textContent = 'Import…';
      try {
        await importRank(Number(rankSelect.value));
      } finally {
        importBtn.disabled = false;
        importBtn.textContent = 'Importer et ouvrir Google Chat';
      }
    });
    card = h(
      'div',
      { class: 'card form' },
      h('p', { class: 'hint' }, 'E-mails non détectés automatiquement. Choisis le rang du compte dans ton Chrome :'),
      h('label', { class: 'field' }, h('span', {}, 'Compte Google à reprendre'), rankSelect),
      h('div', { class: 'actions' }, importBtn),
    );
  } else {
    // Point de départ : choix du profil + recherche des comptes.
    card = h(
      'div',
      { class: 'card form' },
      h('label', { class: 'field' }, h('span', {}, 'Profil Chrome'), profileSelect),
      h('div', { class: 'actions' }, h('button', { class: 'btn primary', disabled: searching, onclick: () => void search() }, searching ? 'Recherche des comptes…' : 'Rechercher mes comptes Google')),
      h('p', { class: 'hint' }, 'Pas de mot de passe à retaper. macOS va demander l’accès au trousseau « Chrome Safe Storage » : clique sur « Toujours autoriser ».'),
    );
  }

  return h(
    'div',
    { class: 'panel narrow' },
    h(
      'div',
      { class: 'hero' },
      h('span', { class: 'avatar big', style: `--c:${account.color}` }, initials(account.name)),
      h('h1', {}, `Connecter « ${account.name} »`),
      h('p', {}, 'Ce compte n’est pas encore connecté à Google.'),
    ),
    chromeProfiles.length ? card : chromeAccessBlocked ? accessBanner() : null,
    h(
      'div',
      { class: 'alt-login' },
      found ? h('button', { class: 'btn ghost', onclick: () => ((found = null), renderContent(true)) }, 'Changer de profil') : null,
      h('button', { class: 'btn ghost', onclick: () => api.showLogin(account.id) }, chromeProfiles.length ? 'Me connecter plutôt avec mon e-mail Google' : 'Me connecter avec mon compte Google'),
    ),
  );
}

// ------------------------------------------------------------------ settings

function accountRow(account: Account, index: number, count: number): HTMLElement {
  const update = (patch: Partial<Account>) => api.updateAccount(account.id, patch);
  const s = state!.states[account.id];

  return h(
    'div',
    { class: 'acc-row' },
    h('input', { type: 'color', class: 'color', value: account.color, title: 'Couleur', onchange: (e: Event) => update({ color: (e.target as HTMLInputElement).value }) }),
    h(
      'div',
      { class: 'acc-main' },
      h('input', { type: 'text', class: 'inline', value: account.name, maxLength: 40, onchange: (e: Event) => update({ name: (e.target as HTMLInputElement).value }) }),
      h('div', { class: 'acc-sub' }, s?.email ?? 'Non connecté ou e-mail non détecté'),
      h('input', { type: 'url', class: 'inline small', value: account.url, spellcheck: false, title: 'Adresse chargée pour ce compte', onchange: (e: Event) => update({ url: (e.target as HTMLInputElement).value }) }),
    ),
    h('div', { class: 'acc-col' }, h('span', { class: 'mini' }, 'Alertes'), toggle(account.notifications, (v) => update({ notifications: v }))),
    h('div', { class: 'acc-col' }, h('span', { class: 'mini' }, 'Son'), toggle(account.sound, (v) => update({ sound: v }))),
    h('div', { class: 'acc-col' }, h('span', { class: 'mini' }, 'Badge'), toggle(account.includeInBadge, (v) => update({ includeInBadge: v }))),
    h(
      'div',
      { class: 'acc-col' },
      h('span', { class: 'mini' }, 'Zoom'),
      select(String(account.zoom), ['0.8', '0.9', '1', '1.1', '1.2', '1.3', '1.5'].map((z) => [z, `${Math.round(Number(z) * 100)} %`] as [string, string]), (v) => update({ zoom: Number(v) })),
    ),
    h(
      'div',
      { class: 'acc-actions' },
      h('button', { class: 'icon-btn', title: 'Monter', disabled: index === 0, onclick: () => api.moveAccount(account.id, -1) }, '↑'),
      h('button', { class: 'icon-btn', title: 'Descendre', disabled: index === count - 1, onclick: () => api.moveAccount(account.id, 1) }, '↓'),
      h('button', { class: 'icon-btn', title: 'Recharger', onclick: () => api.reloadAccount(account.id) }, '↻'),
      h('button', { class: 'icon-btn danger', title: 'Supprimer', onclick: () => void api.removeAccount(account.id) }, '✕'),
    ),
  );
}

function renderSettings(): HTMLElement {
  const settings = state!.settings;
  const set = api.updateSettings;
  const accounts = settings.accounts;

  return h(
    'div',
    { class: 'panel' },
    h('div', { class: 'panel-head' }, h('h1', {}, 'Réglages'), h('button', { class: 'btn ghost', onclick: () => api.setOverlay(null) }, 'Fermer')),

    h('h2', {}, 'Comptes'),
    h(
      'div',
      { class: 'card table' },
      ...(accounts.length ? accounts.map((a, i) => accountRow(a, i, accounts.length)) : [h('div', { class: 'empty' }, 'Aucun compte pour le moment.')]),
      h('div', { class: 'table-foot' }, h('button', { class: 'btn primary', onclick: () => api.setOverlay('add-account') }, '+ Ajouter un compte')),
    ),

    h('h2', {}, 'Notifications'),
    h(
      'div',
      { class: 'card' },
      row(
        'Ne pas déranger',
        dndText(),
        h(
          'div',
          { class: 'chips' },
          ...([[30, '30 min'], [60, '1 h'], [120, '2 h'], [-1, 'Sans limite']] as [number, string][]).map(([m, label]) => h('button', { class: 'chip', onclick: () => api.setDnd(m) }, label)),
          dndActive() ? h('button', { class: 'chip warn', onclick: () => api.setDnd(0) }, 'Réactiver') : null,
        ),
      ),
      row('Aperçu du message', 'Affiche le texte du message dans la notification macOS.', toggle(settings.showPreview, (v) => set({ showPreview: v }))),
      row(
        'Rebond de l’icône du Dock',
        'Quand un message arrive et que ChatStack n’est pas au premier plan.',
        select(settings.dockBounce, [['none', 'Jamais'], ['informational', 'Une fois'], ['critical', 'Jusqu’à ce que j’ouvre l’app']], (v) => set({ dockBounce: v })),
      ),
      row(
        'Badge du Dock',
        'Total des messages non lus des comptes inclus dans le badge.',
        select(settings.badgeMode, [['count', 'Nombre de non-lus'], ['dot', 'Simple pastille'], ['none', 'Aucun']], (v) => set({ badgeMode: v })),
      ),
      row(
        'Autorisation des notifications',
        'Nécessaire pour les alertes ET pour que macOS affiche le badge du Dock. Active « Pastilles d’icône d’app » dans le volet qui s’ouvre.',
        h('button', { class: 'btn primary', onclick: () => api.requestNotifications() }, 'Autoriser les notifications'),
      ),
      h('p', { class: 'hint pad' }, 'Style des alertes (bannière / alerte persistante) : Réglages Système → Notifications → ChatStack.'),
    ),

    h('h2', {}, 'Général'),
    h(
      'div',
      { class: 'card' },
      row('Ouvrir au démarrage du Mac', 'Lance ChatStack automatiquement à l’ouverture de session.', toggle(settings.launchAtLogin, (v) => set({ launchAtLogin: v }))),
      row('Rester actif quand la fenêtre est fermée', 'Fermer la fenêtre la masque : les alertes continuent d’arriver. ⌘Q pour quitter.', toggle(settings.closeToBackground, (v) => set({ closeToBackground: v }))),
      row('Icône dans la barre des menus', 'Affiche le nombre de non-lus en haut de l’écran.', toggle(settings.showTray, (v) => set({ showTray: v }))),
      row('Ouvrir Google Meet dans le navigateur', 'Recommandé pour les visioconférences (sinon dans une fenêtre ChatStack).', toggle(settings.meetInBrowser, (v) => set({ meetInBrowser: v }))),
    ),

    h(
      'div',
      { class: 'about' },
      `ChatStack ${state!.version} — `,
      h('kbd', {}, '⌘1…9'),
      ' changer de compte · ',
      h('kbd', {}, '⌃⇥'),
      ' compte suivant · ',
      h('kbd', {}, '⌘N'),
      ' ajouter · ',
      h('kbd', {}, '⌘R'),
      ' recharger',
    ),
  );
}

// ------------------------------------------------------------------ render loop

function signature(s: AppState): string {
  const rest: Partial<AppState['settings']> = { ...s.settings };
  delete rest.windowBounds;
  delete rest.activeAccountId;
  const emails = Object.values(s.states).map((st) => st.email);
  const active = s.settings.activeAccountId ? s.states[s.settings.activeAccountId] : undefined;
  const connect = !!active && active.signedOut && !active.showLogin;
  return JSON.stringify({ o: s.overlay, rest, emails, dnd: dndActive(), connect, a: connect ? active.id : null });
}

function activeNeedsConnect(): boolean {
  const id = state?.settings.activeAccountId;
  const st = id ? state!.states[id] : undefined;
  return !!st && st.signedOut && !st.showLogin && state!.settings.accounts.some((a) => a.id === id);
}

function renderContent(force = false): void {
  if (!state) return;
  const sig = signature(state);
  if (!force && sig === renderedSignature) return;
  // Ne pas reconstruire le formulaire pendant une saisie : on attend la fin.
  const focused = document.activeElement;
  if (!force && focused && focused.closest('#content') && /^(INPUT|SELECT|TEXTAREA)$/.test(focused.tagName) && (focused as HTMLInputElement).type !== 'checkbox') {
    pendingRender = true;
    return;
  }
  const content = $('#content');
  const overlayChanged = !renderedSignature.includes(`"o":${JSON.stringify(state.overlay)}`);
  renderedSignature = sig;
  pendingRender = false;
  const scroll = content.scrollTop;
  content.replaceChildren();
  if (state.overlay === 'settings') content.append(renderSettings());
  else if (state.overlay === 'add-account') content.append(renderAddAccount());
  else if (activeNeedsConnect()) content.append(renderConnect(state.settings.accounts.find((a) => a.id === state!.settings.activeAccountId)!));
  else content.append(h('div', { class: 'placeholder' }, h('div', { class: 'logo faded' })));
  if (!overlayChanged) content.scrollTop = scroll;
  (content.querySelector('[autofocus]') as HTMLElement | null)?.focus();
}

function apply(next: AppState): void {
  chromeProfiles = next.chromeProfiles;
  chromeAccessBlocked = next.chromeAccessBlocked;
  state = next;
  document.body.classList.toggle('has-overlay', next.overlay !== null);
  renderSidebar();
  renderContent();
}

document.addEventListener('focusout', () => {
  if (pendingRender) setTimeout(() => renderContent(), 0);
});

$('#add').addEventListener('click', () => api.setOverlay(state?.overlay === 'add-account' && state.settings.accounts.length ? null : 'add-account'));
$('#settings').addEventListener('click', () => api.setOverlay(state?.overlay === 'settings' ? null : 'settings'));
$('#dnd').addEventListener('click', () => api.dndMenu());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state?.overlay && state.settings.accounts.length) api.setOverlay(null);
});

// Rafraîchit l'affichage « Ne pas déranger » (échéance qui passe).
setInterval(() => state && renderSidebar(), 30_000);

api.onState(apply);
void api.getState().then((s) => s && apply(s));
