import { app, clipboard, Menu, shell, type MenuItemConstructorOptions, type WebContents } from 'electron';
import path from 'node:path';

/** UA Chrome « propre » : Google refuse la connexion si l'UA mentionne Electron. */
export function chromeUserAgent(): string {
  const major = process.versions.chrome.split('.')[0];
  return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

export function assetPath(...parts: string[]): string {
  const base = app.isPackaged ? path.join(process.resourcesPath, 'assets') : path.join(app.getAppPath(), 'assets');
  return path.join(base, ...parts);
}

export function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** Ouvre une URL dans le navigateur par défaut (http/https/mailto uniquement). */
export function openExternal(url: string): void {
  const u = parseUrl(url);
  if (!u) return;
  // Redirections Google (https://www.google.com/url?q=…) : on ouvre directement la cible.
  if (/(^|\.)google\.com$/.test(u.hostname) && u.pathname === '/url') {
    const target = u.searchParams.get('q') ?? u.searchParams.get('url');
    if (target) return openExternal(target);
  }
  if (['http:', 'https:', 'mailto:'].includes(u.protocol)) {
    void shell.openExternal(u.toString());
  }
}

/** Pages qui doivent rester dans l'app (connexion Google, Chat lui-même). */
export function isInAppUrl(u: URL): boolean {
  const host = u.hostname;
  if (host === 'chat.google.com' || host === 'accounts.google.com' || host.endsWith('.accounts.google.com')) return true;
  if (host === 'mail.google.com' && u.pathname.startsWith('/chat')) return true;
  // Étapes de connexion / changement de compte Google
  if (host === 'www.google.com' && /^\/(accounts|signin|recaptcha)/.test(u.pathname)) return true;
  if (host === 'myaccount.google.com' || host === 'gds.google.com') return true;
  return false;
}

export function isMeetUrl(u: URL): boolean {
  return u.hostname === 'meet.google.com';
}

/** Menu contextuel : orthographe, liens, images, édition. */
export function attachContextMenu(wc: WebContents): void {
  wc.on('context-menu', (_event, params) => {
    const items: MenuItemConstructorOptions[] = [];
    const sep: MenuItemConstructorOptions = { type: 'separator' };

    if (params.misspelledWord) {
      const suggestions = params.dictionarySuggestions.slice(0, 5);
      if (suggestions.length === 0) items.push({ label: 'Aucune suggestion', enabled: false });
      for (const s of suggestions) items.push({ label: s, click: () => wc.replaceMisspelling(s) });
      items.push(
        { label: 'Ajouter au dictionnaire', click: () => wc.session.addWordToSpellCheckerDictionary(params.misspelledWord) },
        sep,
      );
    }

    if (params.linkURL) {
      items.push(
        { label: 'Ouvrir le lien dans le navigateur', click: () => openExternal(params.linkURL) },
        { label: 'Copier le lien', click: () => clipboard.writeText(params.linkURL) },
        sep,
      );
    }

    if (params.mediaType === 'image' && params.srcURL) {
      items.push(
        { label: "Copier l'image", click: () => wc.copyImageAt(params.x, params.y) },
        { label: "Enregistrer l'image…", click: () => wc.downloadURL(params.srcURL) },
        sep,
      );
    }

    if (params.isEditable) {
      items.push(
        { role: 'cut', label: 'Couper', enabled: params.editFlags.canCut },
        { role: 'copy', label: 'Copier', enabled: params.editFlags.canCopy },
        { role: 'paste', label: 'Coller', enabled: params.editFlags.canPaste },
        { role: 'pasteAndMatchStyle', label: 'Coller sans mise en forme', enabled: params.editFlags.canPaste },
        { role: 'selectAll', label: 'Tout sélectionner' },
      );
    } else if (params.selectionText.trim()) {
      items.push({ role: 'copy', label: 'Copier' });
    }

    items.push(sep, { label: 'Recharger', click: () => wc.reload() });
    if (!app.isPackaged) {
      items.push({ label: "Inspecter l'élément", click: () => wc.inspectElement(params.x, params.y) });
    }

    const cleaned = items.filter((item, i) => {
      if (item.type !== 'separator') return true;
      return i > 0 && items[i - 1].type !== 'separator';
    });
    Menu.buildFromTemplate(cleaned).popup();
  });
}
