// Sandboxed preload: exposes exactly the bridge in src/shared/bridge.ts and
// nothing else (no ipcRenderer, no Node). Main validates every call.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC, type BridgeEvent, type ConnectionState, type DraftTideBridge } from '../shared/bridge.ts';

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const handler = (_e: IpcRendererEvent, value: T) => listener(value);
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

const bridge: DraftTideBridge = {
  invoke: (op, payload) => ipcRenderer.invoke(IPC.invoke, op, payload),
  chooseFolder: (defaultPath) => ipcRenderer.invoke(IPC.chooseFolder, defaultPath),
  openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url),
  copyText: (text) => ipcRenderer.invoke(IPC.copyText, text),
  agentSetup: () => ipcRenderer.invoke(IPC.agentSetup),
  connectionState: () => ipcRenderer.invoke(IPC.connectionState),
  reconnect: () => ipcRenderer.invoke(IPC.reconnect),
  onEvent: (listener) => subscribe<BridgeEvent>(IPC.event, listener),
  onConnection: (listener) => subscribe<ConnectionState>(IPC.connection, listener),
};

contextBridge.exposeInMainWorld('draftTide', bridge);
