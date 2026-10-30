import { app, Notification } from 'electron';
import { Controller } from './main/controller';
import { chromeUserAgent } from './main/web';

// NB : ne PAS appeler app.setName() — sur macOS cela détache l'app de sa tuile
// Dock et le badge de non-lus ne s'affiche plus. Le nom vient de CFBundleName.
app.userAgentFallback = chromeUserAgent();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let controller: Controller | null = null;

  app.on('second-instance', () => controller?.showWindow());

  app.whenReady().then(() => {
    // NB : ne PAS appeler app.setAboutPanelOptions({ applicationName }) — comme
    // app.setName(), définir le nom détache la tuile Dock et supprime le badge.
    // Le panneau « À propos » utilise le nom et la version du bundle.

    // Enregistre l'app auprès du centre de notifications macOS au 1er lancement :
    // déclenche la demande d'autorisation (indispensable pour les alertes ET pour
    // que le badge du Dock soit autorisé). Notification silencieuse et sans contenu.
    if (Notification.isSupported()) {
      try {
        new Notification({ title: 'ChatStack', body: 'Notifications activées.', silent: true }).show();
      } catch {
        // ignore
      }
    }

    controller = new Controller();
    controller.start();
  });

  app.on('window-all-closed', () => undefined);
}
