/**
 * ESC/POS command builder for 58 mm and 80 mm thermal receipt printers.
 *
 * Why this exists: most inexpensive thermal printers sold in Bangladesh have no
 * Bengali character set in firmware. Printing Bengali as text produces garbage.
 * Therefore the Bengali receipt is rendered to a 1-bit bitmap by Chromium (in
 * the main process) and sent with the `GS v 0` raster command — the printer
 * only has to print an image it already supports.
 *
 * Everything here is pure byte construction, so it can be asserted in tests
 * without a printer attached. Physical printing remains a manual verification
 * item (see PROJECT_PROGRESS.md, limitation L3).
 */

export type Align = 'left' | 'center' | 'right';

export class EscPosBuilder {
  private chunks: Buffer[] = [];

  constructor(private readonly paperWidthMm: 58 | 80 = 80) {}

  /** Characters per line for the built-in font at the selected paper width. */
  get lineWidth(): number {
    return this.paperWidthMm === 58 ? 32 : 48;
  }

  raw(bytes: number[] | Buffer): this {
    this.chunks.push(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
    return this;
  }

  init(): this {
    return this.raw([0x1b, 0x40]); // ESC @
  }

  align(mode: Align): this {
    const value = mode === 'center' ? 1 : mode === 'right' ? 2 : 0;
    return this.raw([0x1b, 0x61, value]);
  }

  bold(on: boolean): this {
    return this.raw([0x1b, 0x45, on ? 1 : 0]);
  }

  underline(on: boolean): this {
    return this.raw([0x1b, 0x2d, on ? 1 : 0]);
  }

  doubleSize(on: boolean): this {
    return this.raw([0x1d, 0x21, on ? 0x11 : 0x00]);
  }

  /** Print a line of text (ASCII / Latin-1 only — use raster for Bengali). */
  text(value: string): this {
    return this.raw(Buffer.from(value, 'latin1'));
  }

  line(value = ''): this {
    return this.text(value).raw([0x0a]);
  }

  feed(lines = 1): this {
    return this.raw([0x1b, 0x64, Math.min(Math.max(lines, 0), 255)]);
  }

  rule(char = '-'): this {
    return this.line(char.repeat(this.lineWidth));
  }

  /** Print density (0-8) — some printers expose this as DC2 # n. */
  density(level: number): this {
    return this.raw([0x12, 0x23, Math.min(Math.max(level, 0), 8)]);
  }

  cut(partial = false): this {
    return this.raw(partial ? [0x1b, 0x6d] : [0x1d, 0x56, 0x42, 0x00]);
  }

  /** Kick the cash drawer connected to the printer's DK port. */
  openCashDrawer(pin = 0, onMs = 25, offMs = 250): this {
    return this.raw([0x1b, 0x70, pin === 5 ? 1 : 0, onMs, offMs]);
  }

  /** Native QR code (model 2). Works on printers with QR support. */
  qr(data: string, size = 6, errorCorrection: 0 | 1 | 2 | 3 = 1): this {
    const payload = Buffer.from(data, 'latin1');
    const len = payload.length + 3;
    const pL = len & 0xff;
    const pH = (len >> 8) & 0xff;
    this.raw([0x1d, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00]); // model 2
    this.raw([0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, Math.min(Math.max(size, 1), 16)]);
    this.raw([0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, errorCorrection]);
    this.raw([0x1d, 0x28, 0x6b, pL, pH, 0x31, 0x50, 0x30]);
    this.raw(payload);
    return this.raw([0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30]);
  }

  /** Native 1-D barcode (CODE128 by default). */
  barcode(data: string, type: 0 | 4 | 73 = 73): this {
    // GS h (height), GS w (width), GS k (print)
    this.raw([0x1d, 0x68, 60]);
    this.raw([0x1d, 0x77, 2]);
    const payload = Buffer.from(data, 'latin1');
    this.raw([0x1d, 0x6b, type, payload.length]);
    this.raw(payload);
    return this.raw([0x0a]);
  }

  /**
   * Raster bitmap (1 bit per pixel, row-major, MSB first).
   * Used for Bengali receipt rendering.
   */
  raster(bitmap: { widthBytes: number; height: number; data: Uint8Array }): this {
    const xL = bitmap.widthBytes & 0xff;
    const xH = (bitmap.widthBytes >> 8) & 0xff;
    const yL = bitmap.height & 0xff;
    const yH = (bitmap.height >> 8) & 0xff;
    this.raw([0x1d, 0x76, 0x30, 0x00, xL, xH, yL, yH]);
    this.raw(Buffer.from(bitmap.data));
    return this;
  }

  /** Image width in dots for the paper size (203 dpi typical). */
  get dotWidth(): number {
    return this.paperWidthMm === 58 ? 384 : 576;
  }

  build(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

/**
 * Convert RGBA pixel data to a 1-bit ESC/POS raster.
 * `threshold` is the luminance cut-off (0-255); default suits 203 dpi thermal.
 */
export function rgbaToRaster(
  rgba: Uint8Array,
  width: number,
  height: number,
  opts: { targetWidthDots?: number; threshold?: number } = {},
): { widthBytes: number; height: number; data: Uint8Array } {
  const targetWidth = Math.min(opts.targetWidthDots ?? width, width);
  const scale = targetWidth / width;
  const outHeight = Math.max(1, Math.round(height * scale));
  const widthBytes = Math.ceil(targetWidth / 8);
  const threshold = opts.threshold ?? 160;
  const data = new Uint8Array(widthBytes * outHeight);

  for (let y = 0; y < outHeight; y++) {
    const srcY = Math.min(height - 1, Math.floor(y / scale));
    for (let x = 0; x < targetWidth; x++) {
      const srcX = Math.min(width - 1, Math.floor(x / scale));
      const idx = (srcY * width + srcX) * 4;
      const r = rgba[idx] ?? 255;
      const g = rgba[idx + 1] ?? 255;
      const b = rgba[idx + 2] ?? 255;
      const a = rgba[idx + 3] ?? 255;
      // Composite over white, then compare luminance.
      const lum = a < 255 ? 255 - ((255 - (0.299 * r + 0.587 * g + 0.114 * b)) * a) / 255 : 0.299 * r + 0.587 * g + 0.114 * b;
      if (lum < threshold) {
        data[y * widthBytes + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
  }
  return { widthBytes, height: outHeight, data };
}

export interface EscPosReceiptOptions {
  paperWidthMm?: 58 | 80;
  openDrawer?: boolean;
  cut?: boolean;
  density?: number;
  copies?: number;
  /** Optional 1-bit bitmap to append (Bengali receipt image). */
  bitmap?: { widthBytes: number; height: number; data: Uint8Array } | null;
  /** Optional QR payload (e.g. invoice number). */
  qrData?: string | null;
}

/**
 * Build a complete receipt job from plain text lines.
 * When `bitmap` is provided it is printed instead of the text lines (used for
 * Bengali receipts); text lines are still emitted if no bitmap is given.
 */
export function buildEscPosJob(
  textLines: string[],
  opts: EscPosReceiptOptions = {},
): Buffer {
  const paper = opts.paperWidthMm ?? 80;
  const b = new EscPosBuilder(paper);
  b.init();
  if (opts.density !== undefined) b.density(opts.density);
  if (opts.openDrawer) b.openCashDrawer();
  if (opts.bitmap) {
    b.align('center').raster(opts.bitmap);
  } else {
    b.align('left');
    for (const line of textLines) b.line(line.slice(0, b.lineWidth));
  }
  if (opts.qrData) {
    b.feed(1).align('center').qr(opts.qrData, 5).feed(1);
  }
  b.feed(3);
  if (opts.cut !== false) b.cut(false);
  return b.build();
}

/** Wrap a long line to the paper width (character based, Latin text). */
export function wrapLine(text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const out: string[] = [];
  let current = '';
  for (const word of words) {
    if (current.length === 0) {
      current = word;
    } else if (`${current} ${word}`.length <= width) {
      current = `${current} ${word}`;
    } else {
      out.push(current);
      current = word;
    }
  }
  if (current) out.push(current);
  return out;
}

/** Human-readable helper for printer diagnostics screens. */
export function describeEscPosJob(buffer: Buffer): {
  bytes: number;
  hasCut: boolean;
  hasDrawer: boolean;
  hasRaster: boolean;
} {
  return {
    bytes: buffer.length,
    hasCut: buffer.includes(Buffer.from([0x1d, 0x56, 0x42, 0x00])),
    hasDrawer: buffer.includes(Buffer.from([0x1b, 0x70])),
    hasRaster: buffer.includes(Buffer.from([0x1d, 0x76, 0x30])),
  };
}
