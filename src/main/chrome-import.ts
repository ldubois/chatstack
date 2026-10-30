/**
 * Import de la connexion Google depuis un profil Chrome : évite de se
 * reconnecter (mot de passe, 2FA) pour chaque compte ajouté dans ChatStack.
 *
 * Les cookies Chrome sont chiffrés (AES-128-CBC) avec une clé dérivée du secret
 * « Chrome Safe Storage » du trousseau macOS : la première lecture déclenche une
 * demande d'autorisation du trousseau.
 */
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Session } from 'electron';
import type { ChromeProfile, GoogleAccount } from '../shared/types';

const run = promisify(execFile);
const CHROME_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
/** Décalage entre l'époque Windows (1601) utilisée par Chrome et l'époque Unix, en secondes. */
const WINDOWS_EPOCH_OFFSET = 11_644_473_600;

interface ChromeCookieRow {
  host_key: string;
  name: string;
  path: string;
  encrypted_hex: string;
  value: string;
  expires_utc: number;
  is_secure: number;
  is_httponly: number;
  samesite: number;
}

/** Chrome présent sur le Mac, mais macOS refuse l'accès à ses données (TCC). */
export function isChromeAccessBlocked(): boolean {
  try {
    fs.accessSync(path.join(CHROME_DIR, 'Local State'), fs.constants.R_OK);
    return false;
  } catch (err) {
    // ENOENT = Chrome pas installé (pas un blocage) ; EPERM/EACCES = accès refusé.
    return (err as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

export function listChromeProfiles(): ChromeProfile[] {
  try {
    const localState = JSON.parse(fs.readFileSync(path.join(CHROME_DIR, 'Local State'), 'utf8'));
    const cache = localState?.profile?.info_cache ?? {};
    return Object.entries<any>(cache)
      .filter(([dir]) => fs.existsSync(path.join(CHROME_DIR, dir, 'Cookies')))
      .map(([dir, info]) => ({ dir, name: String(info.name ?? dir), email: info.user_name ? String(info.user_name) : null }));
  } catch (err) {
    console.error('[chrome-import] profils Chrome illisibles', err);
    return [];
  }
}

let cachedKey: Buffer | null = null;

async function chromeKey(): Promise<Buffer> {
  if (cachedKey) return cachedKey;
  const { stdout } = await run('/usr/bin/security', ['find-generic-password', '-w', '-s', 'Chrome Safe Storage', '-a', 'Chrome']);
  cachedKey = crypto.pbkdf2Sync(stdout.trim(), 'saltysalt', 1003, 16, 'sha1');
  return cachedKey;
}

function decrypt(hex: string, key: Buffer, hostKey: string): string | null {
  const data = Buffer.from(hex, 'hex');
  if (data.length < 4 || data.subarray(0, 3).toString() !== 'v10') return null;
  try {
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '));
    const plain = Buffer.concat([decipher.update(data.subarray(3)), decipher.final()]);
    // Chrome récent préfixe le clair par SHA256(host_key) (32 octets) — mais pas tous
    // les cookies. On ne retire le préfixe que s'il correspond vraiment à l'empreinte.
    const hash = crypto.createHash('sha256').update(hostKey).digest();
    const prefixed = plain.length >= 32 && plain.subarray(0, 32).equals(hash);
    return (prefixed ? plain.subarray(32) : plain).toString('utf8');
  } catch {
    return null;
  }
}

/** Lit la base de cookies (copiée : Chrome la verrouille) via le sqlite3 de macOS. */
async function readCookies(profileDir: string): Promise<ChromeCookieRow[]> {
  const source = path.join(CHROME_DIR, profileDir, 'Cookies');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chatstack-cookies-'));
  try {
    for (const suffix of ['', '-wal', '-journal']) {
      if (fs.existsSync(source + suffix)) fs.copyFileSync(source + suffix, path.join(tmp, 'Cookies' + suffix));
    }
    const db = path.join(tmp, 'Cookies');
    const sql =
      "SELECT host_key, name, path, hex(encrypted_value) AS encrypted_hex, value, expires_utc, is_secure, is_httponly, samesite " +
      "FROM cookies WHERE host_key = 'google.com' OR host_key LIKE '%.google.com'";
    const { stdout: json } = await run('/usr/bin/sqlite3', ['-readonly', '-json', db, sql], { maxBuffer: 20 * 1024 * 1024 });
    return json.trim() ? JSON.parse(json) : [];
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const SAME_SITE: Record<number, 'no_restriction' | 'lax' | 'strict' | 'unspecified'> = {
  0: 'no_restriction',
  1: 'lax',
  2: 'strict',
};

/** Copie les cookies Google du profil Chrome dans la session du compte. Retourne le nombre importé. */
export async function importGoogleSession(profileDir: string, ses: Session): Promise<number> {
  if (!listChromeProfiles().some((p) => p.dir === profileDir)) throw new Error('Profil Chrome introuvable.');
  const [key, rows] = await Promise.all([chromeKey(), readCookies(profileDir)]);
  const now = Date.now() / 1000;
  let imported = 0;

  for (const row of rows) {
    const value = row.encrypted_hex ? decrypt(row.encrypted_hex, key, row.host_key) : row.value;
    if (value === null) continue;
    const expires = row.expires_utc ? row.expires_utc / 1e6 - WINDOWS_EPOCH_OFFSET : undefined;
    if (expires !== undefined && expires < now) continue;

    const host = row.host_key.replace(/^\./, '');
    const hostOnly = !row.host_key.startsWith('.') || row.name.startsWith('__Host-');
    try {
      await ses.cookies.set({
        url: `https://${host}${row.path || '/'}`,
        name: row.name,
        value,
        domain: hostOnly ? undefined : row.host_key,
        path: row.path || '/',
        secure: Boolean(row.is_secure) || row.name.startsWith('__Secure-') || row.name.startsWith('__Host-'),
        httpOnly: Boolean(row.is_httponly),
        expirationDate: expires,
        sameSite: SAME_SITE[row.samesite] ?? 'unspecified',
      });
      imported++;
    } catch {
      // Cookie refusé (attributs incohérents) : on passe au suivant.
    }
  }
  await ses.cookies.flushStore();
  if (imported === 0) throw new Error('Aucune connexion Google trouvée dans ce profil Chrome.');
  return imported;
}

/**
 * Comptes Google connectés dans le profil, avec leur e-mail. Lu directement dans
 * le fichier `Preferences` du profil Chrome (clé `account_info`) — aucune requête
 * réseau, 100 % fiable. L'ordre correspond en général à l'index /u/N.
 */
export function listGoogleAccounts(profileDir: string): GoogleAccount[] {
  try {
    const prefs = JSON.parse(fs.readFileSync(path.join(CHROME_DIR, profileDir, 'Preferences'), 'utf8'));
    const info: any[] = Array.isArray(prefs?.account_info) ? prefs.account_info : [];
    const accounts: GoogleAccount[] = [];
    info.forEach((a, index) => {
      const email = typeof a?.email === 'string' ? a.email.trim() : '';
      if (!email || accounts.some((x) => x.email === email)) return;
      const name = (typeof a?.full_name === 'string' && a.full_name.trim()) || (typeof a?.given_name === 'string' && a.given_name.trim()) || email.split('@')[0];
      accounts.push({ index, email, name });
    });
    return accounts;
  } catch (err) {
    console.error('[chrome-import] account_info illisible', err);
    return [];
  }
}
