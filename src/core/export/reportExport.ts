/**
 * Export layer: CSV, Excel (.xlsx) and print-ready HTML for PDF generation.
 *
 * CSV is written as UTF-8 **with BOM** so Bengali text opens correctly in
 * Microsoft Excel on Windows, which is what shop owners actually use.
 */
import { deflateRawSync } from 'node:zlib';
import type { ReportTable } from '../reports/reports';
import { formatPaisa, formatQty } from '../foundation/money';

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------
function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function reportToCsv(report: ReportTable, opts: { lang?: 'en' | 'bn' } = {}): string {
  const lang = opts.lang ?? 'en';
  const header = report.columns.map((c) => csvCell(lang === 'bn' ? c.labelBn : c.label));
  const lines: string[] = [header.join(',')];
  for (const row of report.rows) {
    lines.push(
      report.columns
        .map((c) => {
          const v = row[c.key];
          if (c.type === 'money') return csvCell(((Number(v ?? 0)) / 100).toFixed(2));
          if (c.type === 'qty') return csvCell((Number(v ?? 0) / 1000).toString());
          return csvCell(v as string | number | null);
        })
        .join(','),
    );
  }
  if (report.totals) {
    const totalsRow = report.columns.map((c, i) => {
      const v = report.totals?.[c.key];
      if (i === 0 && v === undefined) return csvCell('TOTAL');
      if (v === undefined) return '';
      if (c.type === 'money') return csvCell((Number(v) / 100).toFixed(2));
      if (c.type === 'qty') return csvCell((Number(v) / 1000).toString());
      return csvCell(v as string | number | null);
    });
    lines.push(totalsRow.join(','));
  }
  return '\uFEFF' + lines.join('\r\n');
}

// ---------------------------------------------------------------------------
// Minimal XLSX writer (no dependencies)
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

interface ZipEntry {
  name: string;
  data: Buffer;
}

/** Build a ZIP archive (deflate) — enough for a valid xlsx package. */
function buildZip(entries: ZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const compressed = deflateRawSync(entry.data, { level: 9 });
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 flag
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0, 12); // date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBuf, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuf);

    offset += local.length + nameBuf.length + compressed.length;
  }

  const centralSize = centralParts.reduce((a, b) => a + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, end]);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function columnLetter(index: number): string {
  let n = index;
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export function reportToXlsx(report: ReportTable, opts: { lang?: 'en' | 'bn' } = {}): Buffer {
  const lang = opts.lang ?? 'en';
  const rowsXml: string[] = [];
  let rowIndex = 1;

  const pushRow = (cells: Array<{ value: string | number | null; money?: boolean; header?: boolean }>) => {
    const cellsXml = cells
      .map((cell, i) => {
        const ref = `${columnLetter(i + 1)}${rowIndex}`;
        const style = cell.header ? ' s="1"' : cell.money ? ' s="2"' : '';
        if (cell.value === null || cell.value === undefined || cell.value === '') return '';
        if (typeof cell.value === 'number') {
          return `<c r="${ref}"${style}><v>${cell.value}</v></c>`;
        }
        return `<c r="${ref}"${style} t="inlineStr"><is><t>${escapeXml(cell.value)}</t></is></c>`;
      })
      .join('');
    rowsXml.push(`<row r="${rowIndex}">${cellsXml}</row>`);
    rowIndex++;
  };

  pushRow([{ value: report.title, header: true }]);
  pushRow([{ value: `${report.meta?.from ?? ''} ${report.meta?.to ?? ''}`.trim() }]);
  pushRow([]);
  pushRow(
    report.columns.map((c) => ({ value: lang === 'bn' ? c.labelBn : c.label, header: true })),
  );

  for (const row of report.rows) {
    pushRow(
      report.columns.map((c) => {
        const raw = row[c.key];
        if (c.type === 'money') return { value: Number(raw ?? 0) / 100, money: true };
        if (c.type === 'qty') return { value: Number(raw ?? 0) / 1000, money: true };
        if (c.type === 'int') return { value: Number(raw ?? 0), money: true };
        return { value: (raw ?? '') as string | number | null };
      }),
    );
  }

  if (report.totals) {
    pushRow(
      report.columns.map((c, i) => {
        const v = report.totals?.[c.key];
        if (i === 0 && v === undefined) return { value: 'TOTAL', header: true };
        if (v === undefined) return { value: null };
        if (c.type === 'money' || c.type === 'int') return { value: Number(v) / 100, money: true };
        if (c.type === 'qty') return { value: Number(v) / 1000, money: true };
        return { value: v as string | number };
      }),
    );
  }

  const colWidths = report.columns
    .map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width ?? 18}" customWidth="1"/>`)
    .join('');

  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <cols>${colWidths}</cols>
  <sheetData>${rowsXml.join('')}</sheetData>
</worksheet>`;

  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="${escapeXml(report.title.slice(0, 28))}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;

  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2">
    <font><sz val="11"/><name val="Calibri"/></font>
    <font><b/><sz val="11"/><name val="Calibri"/></font>
  </fonts>
  <fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
  <borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="3">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
  </cellXfs>
</styleSheet>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  return buildZip([
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(rootRels, 'utf8') },
    { name: 'xl/workbook.xml', data: Buffer.from(workbookXml, 'utf8') },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(workbookRels, 'utf8') },
    { name: 'xl/styles.xml', data: Buffer.from(stylesXml, 'utf8') },
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheetXml, 'utf8') },
  ]);
}

// ---------------------------------------------------------------------------
// Print-ready HTML (used for on-screen print preview and PDF via printToPDF)
// ---------------------------------------------------------------------------
export interface BusinessHeader {
  name: string;
  nameBn?: string;
  address?: string;
  phone?: string;
  email?: string;
  vatRegNo?: string;
}

export function formatCellValue(
  value: string | number | null | undefined,
  type: ReportTable['columns'][number]['type'],
): string {
  if (value === null || value === undefined || value === '') return '';
  switch (type) {
    case 'money':
      return formatPaisa(Number(value));
    case 'qty':
      return formatQty(Number(value));
    case 'int':
      return String(Number(value));
    default:
      return String(value);
  }
}

export function reportToHtml(
  report: ReportTable,
  business: BusinessHeader,
  opts: { lang?: 'en' | 'bn'; title?: string } = {},
): string {
  const lang = opts.lang ?? 'bn';
  const headers = report.columns.map((c) => (lang === 'bn' ? c.labelBn : c.label));
  const head = `<tr>${headers.map((h) => `<th>${escapeXml(h)}</th>`).join('')}</tr>`;
  const body = report.rows
    .map(
      (row) =>
        `<tr>${report.columns
          .map((c) => {
            const v = formatCellValue(row[c.key], c.type);
            const align = c.align === 'right' ? ' class="num"' : '';
            return `<td${align}>${escapeXml(v)}</td>`;
          })
          .join('')}</tr>`,
    )
    .join('');

  const totals = report.totals
    ? `<tr class="totals">${report.columns
        .map((c, i) => {
          const v = report.totals?.[c.key];
          if (i === 0 && v === undefined) return '<td>TOTAL</td>';
          if (v === undefined) return '<td></td>';
          return `<td class="${c.align === 'right' ? 'num' : ''}">${escapeXml(
            formatCellValue(v, c.type),
          )}</td>`;
        })
        .join('')}</tr>`
    : '';

  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="utf-8" />
<title>${escapeXml(opts.title ?? report.title)}</title>
<style>
  @font-face { font-family: 'MERQO Bengali'; src: local('Noto Sans Bengali'), local('Nirmala UI'), local('SolaimanLipi'); }
  * { box-sizing: border-box; }
  body { font-family: 'MERQO Bengali', 'Noto Sans Bengali', 'Nirmala UI', 'Segoe UI', sans-serif;
         color: #1f2a37; margin: 24px; font-size: 12px; }
  h1 { font-size: 18px; margin: 0 0 2px; color: #0f5c4a; }
  h2 { font-size: 13px; font-weight: 600; margin: 14px 0 8px; color: #374151; }
  .biz { border-bottom: 2px solid #0f5c4a; padding-bottom: 10px; margin-bottom: 14px; }
  .muted { color: #6b7280; font-size: 11px; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th { background: #f3f6f5; text-align: left; padding: 6px 8px; border-bottom: 1px solid #d7dee2;
       font-size: 11px; text-transform: none; }
  td { padding: 5px 8px; border-bottom: 1px solid #eef1f3; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  tr.totals td { font-weight: 700; border-top: 2px solid #9aa8b2; background: #fafbfc; }
  .footer { margin-top: 18px; font-size: 10px; color: #9aa8b2; display: flex; justify-content: space-between; }
</style>
</head>
<body>
  <div class="biz">
    <h1>${escapeXml(business.nameBn || business.name)}</h1>
    <div class="muted">
      ${business.address ? escapeXml(business.address) + ' · ' : ''}
      ${business.phone ? escapeXml(business.phone) + ' · ' : ''}
      ${business.vatRegNo ? 'VAT: ' + escapeXml(business.vatRegNo) : ''}
    </div>
  </div>
  <h2>${escapeXml(lang === 'bn' ? report.titleBn : report.title)}</h2>
  <div class="muted">
    ${report.meta?.from ? `From ${escapeXml(String(report.meta.from))}` : ''}
    ${report.meta?.to ? ` to ${escapeXml(String(report.meta.to))}` : ''}
  </div>
  <table>
    <thead>${head}</thead>
    <tbody>${body}${totals}</tbody>
  </table>
  <div class="footer">
    <span>MERQO Business Suite v${'MERQO_VERSION'}</span>
    <span>${new Date().toLocaleString('en-GB')}</span>
  </div>
</body>
</html>`;
}
