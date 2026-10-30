import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    icon: './assets/icons/icon',
    appBundleId: 'com.ldubois.chatstack',
    appCategoryType: 'public.app-category.social-networking',
    darwinDarkModeSupport: true,
    extendInfo: {
      NSCameraUsageDescription: 'Google Chat utilise la caméra pour les appels vidéo (huddles).',
      NSMicrophoneUsageDescription: 'Google Chat utilise le micro pour les appels (huddles) et les messages vocaux.',
      NSUserNotificationAlertStyle: 'alert',
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
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
