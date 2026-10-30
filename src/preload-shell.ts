import { contextBridge, ipcRenderer } from 'electron';
import type { AppState, ShellApi } from './shared/types';

const api: ShellApi = {
  getState: () => ipcRenderer.invoke('shell:get-state'),
  onState: (cb) => {
    ipcRenderer.on('shell:state', (_event, state: AppState) => cb(state));
  },
  switchTo: (id) => ipcRenderer.send('shell:switch', id),
  addAccount: (input) => ipcRenderer.invoke('shell:add-account', input),
  updateAccount: (id, patch) => ipcRenderer.send('shell:update-account', id, patch),
  removeAccount: (id) => ipcRenderer.invoke('shell:remove-account', id),
  moveAccount: (id, delta) => ipcRenderer.send('shell:move-account', id, delta),
  reloadAccount: (id) => ipcRenderer.send('shell:reload-account', id),
  accountMenu: (id) => ipcRenderer.send('shell:account-menu', id),
  updateSettings: (patch) => ipcRenderer.send('shell:update-settings', patch),
  setDnd: (minutes) => ipcRenderer.send('shell:set-dnd', minutes),
  setOverlay: (overlay) => ipcRenderer.send('shell:set-overlay', overlay),
  dndMenu: () => ipcRenderer.send('shell:dnd-menu'),
};

contextBridge.exposeInMainWorld('chatstack', api);
