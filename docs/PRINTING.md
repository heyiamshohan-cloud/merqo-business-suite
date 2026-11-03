# Printing

MERQO supports two printing paths. The default is chosen because it is the only one that
reliably produces correct Bengali on the inexpensive thermal printers sold in Bangladesh.

## Why the default path exists

A 58 mm or 80 mm thermal printer typically ships with a Latin-only font ROM. Sending UTF-8
Bengali to it produces garbage or empty boxes. Two problems compound this:

1. **No Bengali glyphs in the device.** Bengali needs conjuncts (যুক্তাক্ষর), vowel signs
   (কার) and hasant forms; a raster of the *rendered text* is the only portable answer.
2. **Windows has no guaranteed Bengali font.** On a fresh Windows install the interface font may
   be missing, so MERQO bundles Noto Sans Bengali with the application.

Both problems are solved by rendering the receipt in Chromium and letting the printer driver
rasterise it: the driver receives pixels, not text, so no font on the device is involved. The
same rendering also gives clean ৳ formatting and mixed Bengali/English lines.

## Path 1 — Windows driver (default, `printing.mode = windows`)

```
ReceiptModel → renderReceiptHtml() → hidden BrowserWindow (offscreen)
             → webContents.print({ deviceName, pageSize: 58/80mm, silent: true })
             → Windows spooler → printer driver rasterises → paper
```

- Implemented in `src/main/printing.ts`, exposed as `printing.printHtml`.
- Paper width: `printing.paper_width_mm` (58 or 80). Height is generous (297 mm) because the
  roll length is determined by the printer, not by the page description.
- `silent: true` prints without a dialog; `printing.printer_name` selects the device, otherwise
  the Windows default is used.
- PDF uses the same window with `printToPDF` (`printing.pdf`, report PDF export).
- Test print: **Settings → Printing → Test print** prints a page containing Bengali conjuncts
  (ক্ষ, ত্র, জ্ঞ, ঞ্চ), kars and ৳ so the operator can confirm the paper output.

## Path 2 — ESC/POS raw (`printing.mode = escpos-raw`)

For printers installed in raw mode or for integrations that spool bytes directly.

`src/core/printing/escpos.ts` builds a byte job:

| Feature | Command |
| --- | --- |
| Initialise | `ESC @` |
| Alignment / bold / double size | `ESC a`, `ESC E`, `GS !` |
| Density | `GS ( E` (printer-dependent; exposed as `printing.density`) |
| QR code (model 2) | `GS ( k` |
| Barcode CODE128 | `GS k` |
| Raster bitmap | `GS v 0` (384 dots for 58 mm, 576 for 80 mm) |
| Cash drawer | `ESC p 0 25 250` |
| Cut | `GS V` |

Bengali still has to be rasterised: `rgbaToRaster()` converts RGBA pixels (from a Chromium
capture) to a 1-bit-per-pixel bitmap with alpha composited over white and a luminance threshold
(default 160), then wraps it in `GS v 0`. QR and barcode data are transmitted natively so they
stay scannable.

`printing.printEscPos` writes the finished job to a `.bin` file in the temp folder and returns
its path plus a description of the commands (`describeEscPosJob`). Sending raw bytes to a
specific Windows queue requires either a raw-mode driver share or a small helper writing to
`\\?\USB...`; that is deliberately left to the deployment, because a wrong byte stream on the
wrong queue can wedge a printer.

## What is tested, and what is not

- **Tested:** ESC/POS command sequences, raster conversion (threshold, alpha, width), receipt
  HTML in Bengali and English at both paper widths, receipt text fallback, invoice/payment/
  expense receipt content matching the stored document (`tests/printing-security.test.ts`,
  `tests/receipt-enforcement.test.ts`).
- **Not tested:** physical paper output on any printer model. No printer was attached to the
  machine that built this project. Vendor-specific quirks (paper-feed length, cut behaviour,
  density range) must be verified on site with the **Test print** button.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Bengali prints as `????` | Bypassed the default path (raw text sent to a Latin-only ROM) | Use `printing.mode = windows`, or rasterise first |
| Receipt cut off on the right | Paper width setting does not match the roll | Settings → Printing → 58 mm / 80 mm |
| Nothing prints, no error | Wrong printer selected, offline queue | Settings → Printing → choose the device; check the Windows queue |
| Very light print | Density too low | Increase `printing.density` (ESC/POS mode) or adjust the driver |
| Drawer does not open | Drawer not wired to the printer's kick port, or drawer disabled | Settings → `printing.cash_drawer`, and check the cable |
