/**
 * Printing and PDF generation.
 *
 * Strategy: render the receipt/report HTML in a hidden Chromium window and hand
 * it to the Windows print spooler via `webContents.print()`. This is the most
 * reliable route for the thermal printers used in Bangladesh, because:
 *   - it works with any printer that has a Windows driver (58 mm and 80 mm),
 *   - Chromium renders Bengali (যুক্তাক্ষর/কার/ফলা) correctly and the driver
 *     rasterises it, so no Bengali font is required in the printer firmware,
 *   - no native module or vendor SDK is needed.
 *
 * Raw ESC/POS byte generation is also available (`buildEscPosJob`) for
 * printers/installs configured in raw mode; see docs/PRINTING.md.
 */
import { BrowserWindow, app } from 'electron';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface PdfResult {
  path: string;
  bytes: number;
}

async function withHiddenWindow<T>(html: string, fn: (win: BrowserWindow) => Promise<T>): Promise<T> {
  const win = new BrowserWindow({
    show: false,
    width: 800,
    height: 1000,
    webPreferences: {
      offscreen: true,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // Chromium blocks top-level `data:` navigation, so the document is written to
  // a temporary file and loaded from disk. The directory is removed afterwards.
  const dir = mkdtempSync(join(tmpdir(), 'merqo-print-'));
  const file = join(dir, 'document.html');
  writeFileSync(file, html, 'utf8');
  try {
    await win.loadFile(file);
    // Give Chromium a tick to lay out fonts (Bengali shaping) before capture.
    await new Promise((resolve) => setTimeout(resolve, 120));
    return await fn(win);
  } finally {
    win.destroy();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

export interface PrintOptions {
  deviceName?: string;
  copies?: number;
  silent?: boolean;
  /** Receipt paper width in millimetres (58 or 80). */
  paperWidthMm?: number;
  landscape?: boolean;
}

export async function printHtml(html: string, opts: PrintOptions = {}): Promise<{ ok: boolean; reason?: string }> {
  return withHiddenWindow(html, async (win) => {
    const paperWidthMm = opts.paperWidthMm ?? 80;
    return new Promise<{ ok: boolean; reason?: string }>((resolve) => {
      win.webContents.print(
        {
          silent: opts.silent ?? false,
          printBackground: true,
          deviceName: opts.deviceName || undefined,
          copies: Math.max(1, Math.min(opts.copies ?? 1, 10)),
          landscape: opts.landscape ?? false,
          margins: { marginType: 'none' },
          // Thermal roll paper: full width, generous height so long receipts are
          // not clipped. Real paper length is determined by the printer.
          pageSize: opts.paperWidthMm
            ? { width: Math.round(paperWidthMm * 1000), height: Math.round(297 * 1000) }
            : 'A4',
        },
        (success, failureReason) => {
          resolve({ ok: success, reason: failureReason });
        },
      );
    });
  });
}

export async function htmlToPdf(html: string, outputPath: string): Promise<PdfResult> {
  return withHiddenWindow(html, async (win) => {
    const pdf = await win.webContents.printToPDF({
      printBackground: true,
      margins: { marginType: 'none' },
      pageSize: 'A4',
    });
    writeFileSync(outputPath, pdf);
    return { path: outputPath, bytes: pdf.length };
  });
}

export async function listPrinters(): Promise<Array<{ name: string; displayName: string; isDefault: boolean }>> {
  const win = BrowserWindow.getAllWindows()[0] ?? null;
  if (!win) return [];
  try {
    const printers = await win.webContents.getPrintersAsync();
    return printers.map((p) => ({
      name: p.name,
      displayName: p.displayName,
      isDefault: p.isDefault ?? false,
    }));
  } catch {
    return [];
  }
}

export function appVersion(): string {
  return app.getVersion();
}
