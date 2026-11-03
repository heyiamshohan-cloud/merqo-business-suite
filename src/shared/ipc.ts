/**
 * IPC contract shared by the main process, the preload bridge and the renderer.
 *
 * The renderer never touches Node, the file system or the database. It can only
 * call the whitelisted `module.method` pairs registered in
 * `src/main/ipc/registry.ts`. Unknown modules/methods are rejected, so a
 * compromised renderer cannot reach arbitrary main-process code.
 */
export type {
  AppInfo,
  SessionInfo,
  IpcRequest,
  IpcErrorPayload,
  IpcResponse,
  AppEvent,
} from './types';

export const IPC_CHANNEL = 'merqo:call';
export const IPC_EVENT_CHANNEL = 'merqo:event';
