/**
 * Preload bridge.
 *
 * The only surface the renderer can reach. Node integration is disabled and the
 * context is isolated; the renderer receives a frozen object with a single
 * `call` function and an event subscription.
 */
import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNEL, IPC_EVENT_CHANNEL } from '../shared/ipc';
import type { AppEvent, IpcRequest, IpcResponse } from '../shared/types';

export interface MerqoBridge {
  call<T = unknown>(module: string, method: string, args?: unknown): Promise<IpcResponse<T>>;
  onEvent(listener: (event: AppEvent) => void): () => void;
  versions: { electron: string; node: string; chrome: string };
}

const bridge: MerqoBridge = {
  call<T = unknown>(module: string, method: string, args?: unknown): Promise<IpcResponse<T>> {
    const request: IpcRequest = { module, method, args };
    return ipcRenderer.invoke(IPC_CHANNEL, request) as Promise<IpcResponse<T>>;
  },
  onEvent(listener: (event: AppEvent) => void): () => void {
    const handler = (_e: unknown, payload: AppEvent) => listener(payload);
    ipcRenderer.on(IPC_EVENT_CHANNEL, handler);
    return () => {
      ipcRenderer.removeListener(IPC_EVENT_CHANNEL, handler);
    };
  },
  versions: {
    electron: process.versions.electron ?? '',
    node: process.versions.node ?? '',
    chrome: process.versions.chrome ?? '',
  },
};

contextBridge.exposeInMainWorld('merqo', bridge);
