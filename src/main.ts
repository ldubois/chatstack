import { app } from 'electron';
import { Controller } from './main/controller';
import { chromeUserAgent } from './main/web';

app.setName('ChatStack');
app.userAgentFallback = chromeUserAgent();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let controller: Controller | null = null;

  app.on('second-instance', () => controller?.showWindow());

  app.whenReady().then(() => {
    app.setAboutPanelOptions({
      applicationName: 'ChatStack',
      applicationVersion: app.getVersion(),
      copyright: '© 2026 Ludovic Dubois — MIT',
      credits: 'Tous tes comptes Google Chat, une seule app.',
    });
    controller = new Controller();
    controller.start();
  });

  // L'app reste ouverte sans fenêtre pour continuer à recevoir les alertes.
  app.on('window-all-closed', () => undefined);
}
