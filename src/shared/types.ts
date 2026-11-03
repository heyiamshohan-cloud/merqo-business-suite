/**
 * Types shared between the main process, the preload bridge and the renderer.
 * Kept free of runtime imports so both sides can use them safely.
 */
export interface AppInfo {
  name: string;
  version: string;
  productName: string;
  founder: string;
  contact: string;
  electron: string;
  node: string;
  chrome: string;
  platform: string;
  databasePath: string;
  dataDir: string;
  backupDir: string;
  logDir: string;
  deviceHash: string;
  licensed: boolean;
  licenseOrganization: string | null;
  developmentKey: boolean;
}

export interface SessionInfo {
  user: { id: string; username: string; fullName: string; role: string } | null;
  businessName: string;
  businessNameBn: string;
  language: 'bn' | 'en';
  paperWidthMm: number;
  printerName: string;
  taxEnabled: boolean;
  allowNegativeStock: boolean;
}

export type AppEvent =
  | { type: 'license-changed' }
  | { type: 'backup-completed'; path: string }
  | { type: 'restore-completed' }
  | { type: 'data-changed'; module: string }
  | { type: 'toast'; level: 'info' | 'warning' | 'error'; message: string };

export interface IpcRequest {
  module: string;
  method: string;
  args?: unknown;
}

export interface IpcErrorPayload {
  code: string;
  message: string;
  messageBn: string;
  details?: Record<string, unknown>;
}

export type IpcResponse<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: IpcErrorPayload };
