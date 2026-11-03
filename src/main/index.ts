/**
 * Electron main process entry point.
 *
 * Responsibilities: window lifecycle, routing whitelisted IPC calls into the
 * business core, hardening the renderer, and guaranteeing that a routine error
 * never leaves the shop with a blank screen or a corrupted database.
 */
import { app, BrowserWindow, ipcMain, Menu, shell, dialog } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { IPC_CHANNEL, IPC_EVENT_CHANNEL } from '../shared/ipc';
import type { AppEvent, IpcRequest, IpcResponse } from '../shared/types';
import { resolvePaths } from './paths';
import { MerqoAppCore } from './appCore';
import { buildRegistry } from './ipc/registry';
import { toAppError } from '../core/foundation/errors';

// Bundled to CommonJS (`dist/main/index.cjs`), so `__dirname` is provided by the
// Node module wrapper and points at `dist/main`.
let mainWindow: BrowserWindow | null = null;
let core: MerqoAppCore | null = null;
const registry = buildRegistry();

/** Broadcast an event to the renderer (licence changes, backups, toasts). */
function emit(event: AppEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_EVENT_CHANNEL, event);
  }
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1180,
    minHeight: 720,
    show: false,
    backgroundColor: '#f6f7f9',
    title: 'MERQO Business Suite',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload uses require() for the bridge only
      webSecurity: true,
      spellcheck: false,
    },
  });

  win.once('ready-to-show', () => {
    win.show();
    if (process.env.MERQO_DEV === '1') win.webContents.openDevTools({ mode: 'detach' });
  });

  // Harden: no new windows, no navigation away from the bundled UI.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://') && !url.startsWith('data:')) event.preventDefault();
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    core?.log.error('Renderer process gone', { reason: details.reason });
  });

  const devUrl = process.env.MERQO_DEV_URL;
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    const indexHtml = join(__dirname, '../renderer/index.html');
    if (!existsSync(indexHtml)) {
      void win.loadURL(
        `data:text/html;charset=utf-8,${encodeURIComponent(
          `<body style="font-family:sans-serif;padding:40px"><h2>MERQO UI not built</h2>
           <p>Run <code>npm run build:renderer</code> before starting the application.</p></body>`,
        )}`,
      );
    } else {
      void win.loadFile(indexHtml);
    }
  }
  return win;
}

/**
 * Calls that stay available while the evaluation period is over: the owner must
 * always be able to read, export, print, back up, configure the app and activate
 * a licence. Everything else that mutates books is blocked until activation.
 */
const LICENCE_EXEMPT_CALLS = new Set([
  'license.activateFromFile',
  'license.activateFromText',
  'backup.create',
  'backup.verify',
  'backup.prune',
  'backup.applyRestore',
  'settings.update',
  'settings.configureSequence',
  'system.setLanguage',
  'printing.printHtml',
  'printing.printEscPos',
  'printing.pdf',
  'printing.testPrint',
  'exportData.reportCsv',
  'exportData.reportXlsx',
  'exportData.reportPdf',
]);

const WRITE_VERBS = [
  'create', 'update', 'void', 'archive', 'restore', 'remove', 'delete', 'adjust',
  'receive', 'pay', 'add', 'hold', 'opening', 'configure', 'prune', 'apply',
  'activate', 'printHtml', 'printEscPos',
];

function isWriteCall(module: string, method: string): boolean {
  if (LICENCE_EXEMPT_CALLS.has(`${module}.${method}`)) return false;
  return WRITE_VERBS.some((verb) => method.toLowerCase().startsWith(verb.toLowerCase()));
}

/** Route an IPC request through the whitelist. */
async function handleCall(request: IpcRequest): Promise<IpcResponse> {
  if (!request || typeof request.module !== 'string' || typeof request.method !== 'string') {
    return {
      ok: false,
      error: { code: 'VALIDATION', message: 'Malformed IPC request', messageBn: 'অনুরোধ সঠিক নয়।' },
    };
  }
  const mod = registry[request.module];
  if (!mod) {
    return {
      ok: false,
      error: {
        code: 'PERMISSION_DENIED',
        message: `Unknown module: ${request.module}`,
        messageBn: 'অননুমোদিত অনুরোধ।',
      },
    };
  }
  const handler = mod[request.method];
  if (!handler) {
    return {
      ok: false,
      error: {
        code: 'PERMISSION_DENIED',
        message: `Unknown method: ${request.module}.${request.method}`,
        messageBn: 'অননুমোদিত অনুরোধ।',
      },
    };
  }
  if (!core) {
    return {
      ok: false,
      error: { code: 'INTERNAL', message: 'Core not ready', messageBn: 'অ্যাপ্লিকেশন প্রস্তুত নয়।' },
    };
  }
  try {
    if (isWriteCall(request.module, request.method)) {
      core.assertOperatingAllowed();
    }
    const data = await handler(core, request.args);
    return { ok: true, data };
  } catch (err) {
    const appError = toAppError(err);
    core.log.error('IPC handler failed', {
      module: request.module,
      method: request.method,
      code: appError.code,
      message: appError.message,
    });
    return {
      ok: false,
      error: {
        code: appError.code,
        message: appError.message,
        messageBn: appError.messageBn,
        details: appError.details,
      },
    };
  }
}

async function bootstrap(): Promise<void> {
  const paths = resolvePaths();
  core = new MerqoAppCore(paths, app.getVersion());
  try {
    const report = await core.init();
    core.log.info('Application started', { ...report } as unknown as Record<string, unknown>);
    if (report.developmentKey) {
      core.log.warn('A development licence verification key is embedded in this build');
    }
  } catch (err) {
    const appError = toAppError(err);
    core.log.error('Startup failed', { code: appError.code, message: appError.message });
    dialog.showErrorBox(
      'MERQO could not start',
      `${appError.message}\n\n${appError.messageBn}\n\nDatabase: ${paths.databasePath}`,
    );
    app.exit(1);
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.setName('MERQO');
  app.setAppUserModelId('com.merqo.businesssuite');

  process.on('uncaughtException', (err) => {
    core?.log.error('Uncaught exception', { message: err.message, stack: err.stack });
  });
  process.on('unhandledRejection', (reason) => {
    core?.log.error('Unhandled rejection', { reason: String(reason) });
  });

  void app.whenReady().then(async () => {
    await bootstrap();
    Menu.setApplicationMenu(null);
    ipcMain.handle(IPC_CHANNEL, (_event, request: IpcRequest) => handleCall(request));
    mainWindow = createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
    });
  });

  app.on('window-all-closed', () => {
    void (async () => {
      await core?.close();
      if (process.platform !== 'darwin') app.quit();
    })();
  });

  app.on('before-quit', () => {
    void core?.close();
  });
}

export { emit };
