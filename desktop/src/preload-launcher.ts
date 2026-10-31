import { contextBridge, ipcRenderer } from 'electron';

/** The instance picker's calls into the main process; nothing else crosses. */
contextBridge.exposeInMainWorld('launcher', {
  status: () => ipcRenderer.invoke('launcher:status'),
  list: () => ipcRenderer.invoke('launcher:list'),
  add: (name: string, address: string) => ipcRenderer.invoke('launcher:add', String(name), String(address)),
  remove: (id: string) => ipcRenderer.invoke('launcher:remove', String(id)),
  open: (id: string) => ipcRenderer.invoke('launcher:open', String(id)),
});
