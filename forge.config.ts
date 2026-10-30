import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const BUNDLE_ID = 'com.ldubois.chatstack';

const config: ForgeConfig = {
  hooks: {
    // Signature ad-hoc AVEC le bon identifiant : sinon la signature garde
    // l'identifiant d'Electron (com.github.Electron), ce qui empêche macOS
    // d'enregistrer l'app pour les notifications (et donc le badge du Dock).
    postPackage: async (_forgeConfig, options) => {
      if (options.platform !== 'darwin') return;
      for (const dir of options.outputPaths) {
        const appPath = path.join(dir, 'ChatStack.app');
        try {
          execFileSync('/usr/bin/codesign', ['--remove-signature', appPath], { stdio: 'ignore' });
        } catch {
          // pas de signature à retirer
        }
        execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', '--identifier', BUNDLE_ID, appPath], { stdio: 'inherit' });
      }
    },
  },
  packagerConfig: {
    asar: true,
    icon: './assets/icons/icon',
    appBundleId: 'com.ldubois.chatstack',
    appCategoryType: 'public.app-category.social-networking',
    darwinDarkModeSupport: true,
    extendInfo: {
      NSCameraUsageDescription: 'Google Chat utilise la caméra pour les appels vidéo (huddles).',
      NSMicrophoneUsageDescription: 'Google Chat utilise le micro pour les appels (huddles) et les messages vocaux.',
    },
    extraResource: ['./assets'],
  },
  rebuildConfig: {},
  makers: [
    new MakerDMG({
      icon: './assets/icons/icon.icns',
      format: 'ULFO',
    }),
    new MakerZIP({}, ['darwin']),
  ],
  plugins: [
    new VitePlugin({
      build: [
        { entry: 'src/main.ts', config: 'vite.main.config.ts', target: 'main' },
        { entry: 'src/preload-shell.ts', config: 'vite.preload.config.ts', target: 'preload' },
        { entry: 'src/preload-account.ts', config: 'vite.preload.config.ts', target: 'preload' },
      ],
      renderer: [{ name: 'main_window', config: 'vite.renderer.config.ts' }],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: false,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
