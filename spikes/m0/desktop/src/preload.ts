// Restricted preload: the GUI gets named calls only, never ipcRenderer.
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('draftTide', {
  engineInfo: () => ipcRenderer.invoke('draftTide:engineInfo'),
});
