/**
 * Whitelisted IPC handlers.
 *
 * Every renderer call arrives as `{ module, method, args }`. Only the pairs
 * registered here are executable; anything else is rejected before it can reach
 * application code. Handlers translate validated arguments into `src/core`
 * service calls — the main process contains no business logic of its own.
 */
import { app, dialog, BrowserWindow } from 'electron';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import type { AppInfo, SessionInfo } from '../../shared/types';
import type { MerqoAppCore } from '../appCore';
import { printHtml, htmlToPdf, listPrinters } from '../printing';

import * as catalog from '../../core/catalog/catalog';
import * as parties from '../../core/parties/parties';
import * as sales from '../../core/sales/sales';
import * as purchases from '../../core/purchases/purchases';
import * as returns from '../../core/returns/returns';
import * as payments from '../../core/payments/payments';
import * as expenses from '../../core/expenses/expenses';
import * as inventory from '../../core/inventory/stock';
import * as reports from '../../core/reports/reports';
import * as journal from '../../core/accounting/journal';
import * as accountingReports from '../../core/accounting/reports';
import * as settings from '../../core/services/settings';
import * as auditService from '../../core/services/audit';
import * as backup from '../../core/backup/backup';
import * as license from '../../core/licensing/license';
import * as receipt from '../../core/printing/receipt';
import * as receiptModel from '../../core/printing/receiptModel';
import * as escpos from '../../core/printing/escpos';
import * as reportExport from '../../core/export/reportExport';

export type Handler = (core: MerqoAppCore, args: any) => unknown;

export interface Registry {
  [module: string]: { [method: string]: Handler };
}

export function buildRegistry(): Registry {
  const c = (core: MerqoAppCore) => core.requireCtx();

  return {
    system: {
      appInfo: (core): AppInfo => {
        const st = core.license();
        return {
          name: 'MERQO',
          productName: 'MERQO Business Suite',
          version: core.appVersion,
          founder: 'Shohan Khan',
          contact: 'merqoonline@gmail.com',
          electron: process.versions.electron ?? '',
          node: process.versions.node ?? '',
          chrome: process.versions.chrome ?? '',
          platform: `${process.platform} ${process.arch}`,
          databasePath: core.paths.databasePath,
          dataDir: core.paths.userData,
          backupDir: core.paths.backupDir,
          logDir: core.paths.logDir,
          deviceHash: core.device.summary,
          licensed: st.valid,
          licenseOrganization: st.organization,
          developmentKey: core.isDevelopmentKey,
        };
      },
      session: (core): SessionInfo => {
        const db = core.requireDb();
        const profile = settings.getBusinessProfile(db);
        const user = core.requireCtx().userId
          ? db.get<{ id: string; username: string; full_name: string; role: string }>(
              'SELECT id, username, full_name, role FROM users WHERE id = ?',
              [core.requireCtx().userId],
            )
          : undefined;
        return {
          user: user
            ? { id: user.id, username: user.username, fullName: user.full_name, role: user.role }
            : null,
          businessName: profile.name,
          businessNameBn: profile.nameBn,
          language: core.language(),
          paperWidthMm: settings.getNumberSetting(db, 'printing.paper_width_mm', 80),
          printerName: settings.getSetting(db, 'printing.printer_name') ?? '',
          taxEnabled: profile.taxEnabled,
          allowNegativeStock: settings.getBoolSetting(db, 'inventory.allow_negative'),
        };
      },
      health: (core) => {
        const ctx = c(core);
        return {
          startup: core.startup,
          journalsBalanced: journal.verifyAllJournalsBalanced(ctx),
          inventory: inventory.reconcileInventoryWithLedger(ctx),
        };
      },
      auditLog: (core, args) => auditService.queryAuditLog(c(core), args ?? {}),
      setLanguage: (core, args: { language: 'bn' | 'en' }) => {
        core.setLanguage(args.language);
        return { language: args.language };
      },
      openDataFolder: async (core) => {
        const { shell } = await import('electron');
        await shell.openPath(core.paths.userData);
        return { ok: true };
      },
      openFolder: async (core, args: { path: string }) => {
        const { shell } = await import('electron');
        const result = await shell.openPath(args.path);
        return { ok: result === '' };
      },
    },

    catalog: {
      search: (core, args) => catalog.searchProducts(c(core), args ?? {}),
      get: (core, args: { id: string }) => catalog.getProduct(c(core), args.id),
      create: (core, args) => catalog.createProduct(c(core), args),
      update: (core, args) => catalog.updateProduct(c(core), args),
      archive: (core, args: { id: string }) => {
        catalog.archiveProduct(c(core), args.id);
        return { ok: true };
      },
      restore: (core, args: { id: string }) => {
        catalog.restoreProduct(c(core), args.id);
        return { ok: true };
      },
      remove: (core, args: { id: string }) => {
        catalog.deleteProduct(c(core), args.id);
        return { ok: true };
      },
      findByBarcode: (core, args: { code: string }) => catalog.findByBarcode(c(core), args.code) ?? null,
      barcodes: (core, args: { productId: string }) => catalog.listBarcodes(c(core), args.productId),
      addBarcode: (core, args) => catalog.addBarcode(c(core), args),
      removeBarcode: (core, args: { barcodeId: string }) => {
        catalog.removeBarcode(c(core), args.barcodeId);
        return { ok: true };
      },
      categories: (core, args) => catalog.listCategories(c(core), args?.includeArchived ?? false),
      createCategory: (core, args) => catalog.createCategory(c(core), args),
      updateCategory: (core, args) => catalog.updateCategory(c(core), args.id, args.patch),
      archiveCategory: (core, args: { id: string }) => {
        catalog.archiveCategory(c(core), args.id);
        return { ok: true };
      },
      brands: (core) => catalog.listBrands(c(core)),
      createBrand: (core, args: { name: string }) => catalog.createBrand(c(core), args.name),
      units: (core) => catalog.listUnits(c(core)),
    },

    parties: {
      customers: (core, args) => parties.listCustomers(c(core), args ?? {}),
      customer: (core, args: { id: string }) => parties.getCustomer(c(core), args.id),
      createCustomer: (core, args) => parties.createCustomer(c(core), args),
      updateCustomer: (core, args) => parties.updateCustomer(c(core), args.id, args.patch),
      archiveCustomer: (core, args: { id: string }) => {
        parties.archiveCustomer(c(core), args.id);
        return { ok: true };
      },
      customerStatement: (core, args: { id: string; from?: string; to?: string }) =>
        parties.customerStatement(c(core), args.id, { from: args.from, to: args.to }),
      suppliers: (core, args) => parties.listSuppliers(c(core), args ?? {}),
      supplier: (core, args: { id: string }) => parties.getSupplier(c(core), args.id),
      createSupplier: (core, args) => parties.createSupplier(c(core), args),
      updateSupplier: (core, args) => parties.updateSupplier(c(core), args.id, args.patch),
      archiveSupplier: (core, args: { id: string }) => {
        parties.archiveSupplier(c(core), args.id);
        return { ok: true };
      },
      supplierStatement: (core, args: { id: string; from?: string; to?: string }) =>
        parties.supplierStatement(c(core), args.id, { from: args.from, to: args.to }),
      totals: (core) => ({
        receivables: parties.totalReceivables(c(core)),
        payables: parties.totalPayables(c(core)),
      }),
    },

    sales: {
      create: (core, args) => sales.createSale(c(core), args),
      price: (core, args) => sales.priceSale(c(core), args),
      get: (core, args: { id: string }) => sales.getInvoice(c(core), args.id),
      byNumber: (core, args: { invoiceNo: string }) => sales.findInvoiceByNo(c(core), args.invoiceNo) ?? null,
      list: (core, args) => sales.listInvoices(c(core), args ?? {}),
      void: (core, args: { id: string; reason: string }) => sales.voidSale(c(core), args.id, args.reason),
      totals: (core, args: { from: string; to: string }) => sales.salesTotals(c(core), args),
      hold: (core, args) => sales.holdSale(c(core), args),
      held: (core) => sales.listHeldSales(c(core)),
      deleteHeld: (core, args: { id: string }) => {
        sales.deleteHeldSale(c(core), args.id);
        return { ok: true };
      },
    },

    purchases: {
      create: (core, args) => purchases.createPurchase(c(core), args),
      price: (core, args) => purchases.pricePurchase(c(core), args),
      get: (core, args: { id: string }) => purchases.getPurchase(c(core), args.id),
      list: (core, args) => purchases.listPurchases(c(core), args ?? {}),
      void: (core, args: { id: string; reason: string }) => purchases.voidPurchase(c(core), args.id, args.reason),
      totals: (core, args: { from: string; to: string }) => purchases.purchaseTotals(c(core), args),
    },

    returns: {
      createSalesReturn: (core, args) => returns.createSalesReturn(c(core), args),
      createPurchaseReturn: (core, args) => returns.createPurchaseReturn(c(core), args),
      salesReturns: (core, args) => returns.listSalesReturns(c(core), args ?? {}),
      purchaseReturns: (core, args) => returns.listPurchaseReturns(c(core), args ?? {}),
      returnableInvoiceLines: (core, args: { invoiceId: string }) =>
        returns.returnableInvoiceLines(c(core), args.invoiceId),
      returnablePurchaseLines: (core, args: { purchaseId: string }) =>
        returns.returnablePurchaseLines(c(core), args.purchaseId),
    },

    payments: {
      receiveFromCustomer: (core, args) => payments.receiveFromCustomer(c(core), args),
      paySupplier: (core, args) => payments.paySupplier(c(core), args),
      list: (core, args) => payments.listPayments(c(core), args ?? {}),
      get: (core, args: { id: string }) => payments.getPayment(c(core), args.id),
      allocations: (core, args: { paymentId: string }) => payments.paymentAllocations(c(core), args.paymentId),
    },

    expenses: {
      create: (core, args) => expenses.createExpense(c(core), args),
      update: (core, args) => expenses.updateExpense(c(core), args.id, args.patch),
      void: (core, args: { id: string; reason: string }) => expenses.voidExpense(c(core), args.id, args.reason),
      list: (core, args) => expenses.listExpenses(c(core), args ?? {}),
      get: (core, args: { id: string }) => expenses.getExpense(c(core), args.id),
      categories: (core) => expenses.listExpenseCategories(c(core)),
      createCategory: (core, args) => expenses.createExpenseCategory(c(core), args),
      totals: (core, args: { from: string; to: string }) => expenses.expenseTotals(c(core), args),
    },

    inventory: {
      adjust: (core, args) => {
        const ctx = c(core);
        const result = core.requireDb().transaction(() => {
          const adjustment = inventory.adjustStock(ctx, args);
          if (adjustment.valueDelta !== 0) {
            const lines =
              adjustment.valueDelta > 0
                ? [
                    { accountCode: '1200', debit: adjustment.valueDelta },
                    { accountCode: '5100', credit: adjustment.valueDelta },
                  ]
                : [
                    { accountCode: '5100', debit: -adjustment.valueDelta },
                    { accountCode: '1200', credit: -adjustment.valueDelta },
                  ];
            journal.postJournal(ctx, {
              memo: `Stock adjustment: ${args.reason}`,
              sourceType: 'stock_adjustment',
              lines,
            });
          }
          return adjustment;
        });
        return result;
      },
      level: (core, args: { productId: string }) => inventory.getStockLevel(c(core), args.productId),
      moves: (core, args) => inventory.stockMoves(c(core), args ?? {}),
      lowStock: (core) => inventory.lowStock(c(core)),
      outOfStock: (core) => inventory.outOfStock(c(core)),
      valuation: (core) => inventory.stockValuation(c(core)),
      reconcile: (core) => inventory.reconcileInventoryWithLedger(c(core)),
      openingStock: (core, args) => {
        const ctx = c(core);
        return core.requireDb().transaction(() => {
          const result = inventory.openingStock(ctx, args);
          const value = result.valueAdded;
          if (value > 0) {
            journal.postJournal(ctx, {
              memo: 'Opening stock',
              sourceType: 'opening',
              lines: [
                { accountCode: '1200', debit: value },
                { accountCode: '3100', credit: value },
              ],
            });
          }
          return result;
        });
      },
    },

    reports: {
      catalog: () => reports.REPORT_CATALOG,
      build: (core, args) => reports.buildReport(c(core), args),
      dashboard: (core, args: { from: string; to: string }) => reports.dashboardSummary(c(core), args),
      trialBalance: (core, args: { from: string; to: string }) =>
        accountingReports.trialBalance(c(core), args),
      profitAndLoss: (core, args: { from: string; to: string }) =>
        accountingReports.profitAndLoss(c(core), args),
      balanceSheet: (core, args: { asOf: string }) => accountingReports.balanceSheet(c(core), args.asOf),
      accounts: (core) => core.requireDb().all('SELECT * FROM accounts ORDER BY code'),
      journal: (core, args: { entryId: string }) => journal.getJournalEntry(c(core), args.entryId),
      verifyJournals: (core) => journal.verifyAllJournalsBalanced(c(core)),
    },

    settings: {
      all: (core) => settings.getSettings(core.requireDb()),
      update: (core, args: { patch: Record<string, string | number | boolean> }) =>
        settings.updateSettings(core.requireDb(), args.patch, core.clock.nowIso()),
      business: (core) => settings.getBusinessProfile(core.requireDb()),
      sequences: (core) => core.requireDb().all('SELECT * FROM document_sequences ORDER BY key'),
      configureSequence: (core, args: { key: string; prefix: string; padding: number; nextValue?: number }) =>
        settings.configureSequence(core.requireDb(), args.key, args.prefix, args.padding, args.nextValue),
    },

    license: {
      status: (core) => {
        const st = core.license();
        return {
          ...st,
          evaluation: core.evaluation(),
          deviceSummary: core.device.summary,
          deviceHash: core.device.fingerprint,
          keyFingerprint: core.keyFingerprint,
          developmentKey: core.isDevelopmentKey,
        };
      },
      activateFromFile: async (core) => {
        const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
        const result = await dialog.showOpenDialog(win!, {
          title: 'Select MERQO licence file',
          filters: [{ name: 'MERQO licence', extensions: ['merqo', 'json', 'lic'] }],
          properties: ['openFile'],
        });
        if (result.canceled || result.filePaths.length === 0) return { canceled: true };
        const { readFileSync } = await import('node:fs');
        const text = readFileSync(result.filePaths[0], 'utf8');
        const activation = license.activateLicense(c(core), {
          license: text,
          deviceHash: core.device.fingerprint,
          publicKeyPem: core.publicKeyPem,
        });
        return { canceled: false, activation };
      },
      activateFromText: (core, args: { text: string }) =>
        license.activateLicense(c(core), {
          license: args.text,
          deviceHash: core.device.fingerprint,
          publicKeyPem: core.publicKeyPem,
        }),
      needsActivation: (core) => !core.license().valid,
    },

    backup: {
      list: (core) => backup.listBackups(c(core)),
      create: async (core, args?: { directory?: string }) => {
        let directory = args?.directory;
        if (!directory) {
          const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
          const result = await dialog.showOpenDialog(win!, {
            title: 'Choose backup folder',
            properties: ['openDirectory', 'createDirectory'],
          });
          if (result.canceled || result.filePaths.length === 0) return { canceled: true };
          directory = result.filePaths[0];
        }
        const info = backup.createBackup(c(core), { directory, kind: 'manual' });
        return { canceled: false, backup: info };
      },
      verify: async (core, args: { path?: string }) => {
        let path = args?.path;
        if (!path) {
          const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
          const result = await dialog.showOpenDialog(win!, {
            title: 'Select a MERQO backup file',
            filters: [{ name: 'MERQO backup', extensions: ['db', 'sqlite'] }],
            properties: ['openFile'],
          });
          if (result.canceled || result.filePaths.length === 0) return { canceled: true };
          path = result.filePaths[0];
        }
        const verification = await backup.verifyBackup(path, (f) => import('../../core/db/driver').then((m) => m.openDatabase(f)));
        return { canceled: false, verification };
      },
      restore: async () => {
        const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
        const picked = await dialog.showOpenDialog(win!, {
          title: 'Select a MERQO backup to restore',
          filters: [{ name: 'MERQO backup', extensions: ['db', 'sqlite'] }],
          properties: ['openFile'],
        });
        if (picked.canceled || picked.filePaths.length === 0) return { canceled: true };
        return {
          canceled: false,
          selectedPath: picked.filePaths[0],
          note: 'Restore is applied by the main process with a safety backup, then the app restarts.',
        };
      },
      applyRestore: async (core, args: { backupPath: string }) => {
        const { openDatabase } = await import('../../core/db/driver');
        const plan = await backup.prepareRestore(c(core), {
          backupPath: args.backupPath,
          dbPath: core.paths.databasePath,
          backupDirectory: core.paths.backupDir,
          openFn: (f) => openDatabase(f),
        });
        await core.close();
        backup.applyRestore(plan);
        app.relaunch();
        app.exit(0);
        return { ok: true, safetyBackup: plan.safetyBackup };
      },
      prune: (core, args: { directory: string; keep?: number }) =>
        backup.pruneBackups(c(core), args.directory, args.keep),
      due: (core) => backup.autoBackupDue(c(core)),
    },

    printing: {
      invoiceReceipt: (core, args: { invoiceId: string; lang?: 'bn' | 'en' }) => {
        const model = receiptModel.buildInvoiceReceipt(c(core), args.invoiceId);
        const html = receipt.renderReceiptHtml(model, { lang: args.lang ?? core.language() });
        return { model, html, text: receipt.renderReceiptText(model) };
      },
      paymentReceipt: (core, args: { paymentId: string; lang?: 'bn' | 'en' }) => {
        const model = receiptModel.buildPaymentReceipt(c(core), args.paymentId);
        const html = receipt.renderReceiptHtml(model, { lang: args.lang ?? core.language() });
        return { model, html, text: receipt.renderReceiptText(model) };
      },
      expenseReceipt: (core, args: { expenseId: string; lang?: 'bn' | 'en' }) => {
        const model = receiptModel.buildExpenseReceipt(c(core), args.expenseId);
        const html = receipt.renderReceiptHtml(model, { lang: args.lang ?? core.language() });
        return { model, html, text: receipt.renderReceiptText(model) };
      },
      printHtml: async (core, args: { html: string; deviceName?: string; copies?: number; silent?: boolean; paperWidthMm?: number }) => {
        const result = await printHtml(args.html, {
          deviceName: args.deviceName ?? settings.getSetting(core.requireDb(), 'printing.printer_name') ?? undefined,
          copies: args.copies ?? settings.getNumberSetting(core.requireDb(), 'printing.copies', 1),
          silent: args.silent ?? true,
          paperWidthMm: args.paperWidthMm,
        });
        return result;
      },
      printEscPos: (core, args: { textLines: string[]; qrData?: string | null; openDrawer?: boolean; paperWidthMm?: 58 | 80 }) => {
        const job = escpos.buildEscPosJob(args.textLines, {
          paperWidthMm: args.paperWidthMm ?? 80,
          openDrawer: args.openDrawer,
          qrData: args.qrData ?? null,
        });
        const info = escpos.describeEscPosJob(job);
        // Raw spooling must be configured per printer; we return the byte job so
        // the UI can offer "save as .bin" for raw-mode deployments.
        const path = join(core.paths.tempDir, `escpos-${Date.now()}.bin`);
        writeFileSync(path, job);
        return { path, ...info };
      },
      pdf: async (core, args: { html: string; fileName: string }) => {
        const safe = args.fileName.replace(/[^\w.\- ]+/g, '_');
        const target = join(core.paths.exportDir, `${safe}.pdf`);
        const { mkdirSync } = await import('node:fs');
        mkdirSync(core.paths.exportDir, { recursive: true });
        return htmlToPdf(args.html, target);
      },
      printers: () => listPrinters(),
      testPrint: async (core, args: { deviceName?: string; paperWidthMm?: 58 | 80 }) => {
        const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
          body{font-family:'Noto Sans Bengali','Nirmala UI',sans-serif;width:${
            args.paperWidthMm ?? 80
          }mm;padding:4mm;font-size:12px}
          h1{font-size:16px;margin:0 0 4px} .c{text-align:center}
          </style></head><body>
          <div class="c"><h1>MERQO প্রিন্টার টেস্ট</h1>
          <div>Printer test — ৳1,234.56</div>
          <div>বাংলা যুক্তাক্ষর: ক্ষ, ত্র, জ্ঞ, ঞ্চ</div>
          <div>কার ও ফলা: কীটনাশক / ব্যয় / স্ট্রবেরি</div>
          <div>Mixed: Rice 5kg — ৳1,000.00</div>
          <div style="margin-top:6px">${new Date().toLocaleString('en-GB')}</div>
          </div></body></html>`;
        return printHtml(html, {
          deviceName: args.deviceName,
          silent: true,
          paperWidthMm: args.paperWidthMm ?? 80,
        });
      },
    },

    exportData: {
      reportCsv: async (core, args: { report: reports.ReportTable; fileName: string }) => {
        const csv = reportExport.reportToCsv(args.report, { lang: core.language() });
        const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
        const result = await dialog.showSaveDialog(win!, {
          title: 'Save CSV',
          defaultPath: join(app.getPath('documents'), `${args.fileName}.csv`),
          filters: [{ name: 'CSV', extensions: ['csv'] }],
        });
        if (result.canceled || !result.filePath) return { canceled: true };
        writeFileSync(result.filePath, csv, 'utf8');
        return { canceled: false, path: result.filePath };
      },
      reportXlsx: async (core, args: { report: reports.ReportTable; fileName: string }) => {
        const buf = reportExport.reportToXlsx(args.report, { lang: core.language() });
        const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
        const result = await dialog.showSaveDialog(win!, {
          title: 'Save Excel file',
          defaultPath: join(app.getPath('documents'), `${args.fileName}.xlsx`),
          filters: [{ name: 'Excel', extensions: ['xlsx'] }],
        });
        if (result.canceled || !result.filePath) return { canceled: true };
        writeFileSync(result.filePath, buf);
        return { canceled: false, path: result.filePath };
      },
      reportHtml: (core, args: { report: reports.ReportTable; lang?: 'bn' | 'en' }) =>
        reportExport.reportToHtml(args.report, settings.getBusinessProfile(core.requireDb()), {
          lang: args.lang ?? core.language(),
        }),
      reportPdf: async (core, args: { report: reports.ReportTable; fileName: string }) => {
        const html = reportExport.reportToHtml(args.report, settings.getBusinessProfile(core.requireDb()), {
          lang: core.language(),
        });
        const { mkdirSync } = await import('node:fs');
        mkdirSync(core.paths.exportDir, { recursive: true });
        const target = join(core.paths.exportDir, `${args.fileName.replace(/[^\w.\- ]+/g, '_')}.pdf`);
        return htmlToPdf(html, target);
      },
      /** Deterministic hash used by the UI to confirm what was exported. */
      fingerprint: (_core, args: { content: string }) =>
        createHash('sha256').update(args.content).digest('hex'),
    },
  };
}
