/**
 * Bilingual UI strings (Bengali first, English secondary).
 *
 * Bengali is written as natural shop-floor language rather than literal
 * translation: the terms below are what a Bangladeshi retailer actually uses
 * ("বাকি", "নগদ", "স্টক", "মুনাফা"). English is kept for operators who prefer it
 * and for technical/support purposes.
 */
export type Lang = 'bn' | 'en';

export interface Entry {
  bn: string;
  en: string;
}

export const strings = {
  appName: { bn: 'MERQO বিজনেস স্যুট', en: 'MERQO Business Suite' },
  tagline: { bn: 'বিক্রয় · স্টক · হিসাব', en: 'Sales · Stock · Accounts' },

  // Navigation
  navDashboard: { bn: 'ড্যাশবোর্ড', en: 'Dashboard' },
  navPos: { bn: 'বিক্রয় (POS)', en: 'Point of Sale' },
  navProducts: { bn: 'পণ্য ও স্টক', en: 'Products & Stock' },
  navSales: { bn: 'বিক্রয় তালিকা', en: 'Sales' },
  navPurchases: { bn: 'ক্রয়', en: 'Purchases' },
  navCustomers: { bn: 'গ্রাহক', en: 'Customers' },
  navSuppliers: { bn: 'সরবরাহকারী', en: 'Suppliers' },
  navExpenses: { bn: 'খরচ', en: 'Expenses' },
  navReturns: { bn: 'ফেরত', en: 'Returns' },
  navReports: { bn: 'রিপোর্ট', en: 'Reports' },
  navBackup: { bn: 'ব্যাকআপ', en: 'Backup' },
  navSettings: { bn: 'সেটিংস', en: 'Settings' },
  navAbout: { bn: 'পরিচিতি', en: 'About' },
  navActivation: { bn: 'লাইসেন্স', en: 'Licence' },

  // Common actions
  save: { bn: 'সংরক্ষণ', en: 'Save' },
  cancel: { bn: 'বাতিল', en: 'Cancel' },
  close: { bn: 'বন্ধ', en: 'Close' },
  add: { bn: 'যোগ করুন', en: 'Add' },
  edit: { bn: 'সম্পাদনা', en: 'Edit' },
  delete: { bn: 'মুছুন', en: 'Delete' },
  archive: { bn: 'আর্কাইভ', en: 'Archive' },
  search: { bn: 'খুঁজুন', en: 'Search' },
  print: { bn: 'প্রিন্ট', en: 'Print' },
  preview: { bn: 'প্রিভিউ', en: 'Preview' },
  export: { bn: 'এক্সপোর্ট', en: 'Export' },
  refresh: { bn: 'রিফ্রেশ', en: 'Refresh' },
  confirm: { bn: 'নিশ্চিত করুন', en: 'Confirm' },
  yes: { bn: 'হ্যাঁ', en: 'Yes' },
  no: { bn: 'না', en: 'No' },
  total: { bn: 'সর্বমোট', en: 'Total' },
  subtotal: { bn: 'সাবটোটাল', en: 'Subtotal' },
  discount: { bn: 'ছাড়', en: 'Discount' },
  vat: { bn: 'ভ্যাট', en: 'VAT' },
  paid: { bn: 'পরিশোধিত', en: 'Paid' },
  due: { bn: 'বাকি', en: 'Due' },
  date: { bn: 'তারিখ', en: 'Date' },
  quantity: { bn: 'পরিমাণ', en: 'Quantity' },
  price: { bn: 'মূল্য', en: 'Price' },
  amount: { bn: 'টাকা', en: 'Amount' },
  name: { bn: 'নাম', en: 'Name' },
  phone: { bn: 'মোবাইল', en: 'Mobile' },
  address: { bn: 'ঠিকানা', en: 'Address' },
  note: { bn: 'মন্তব্য', en: 'Note' },
  actions: { bn: 'কার্যক্রম', en: 'Actions' },
  loading: { bn: 'লোড হচ্ছে…', en: 'Loading…' },
  noData: { bn: 'কোনো তথ্য নেই', en: 'No data' },
  noDataHint: { bn: 'নতুন এন্ট্রি যোগ করে শুরু করুন।', en: 'Add a new entry to get started.' },
  saveFailed: { bn: 'সংরক্ষণ করা যায়নি', en: 'Save failed' },
  saved: { bn: 'সংরক্ষিত হয়েছে', en: 'Saved' },
  required: { bn: 'আবশ্যক', en: 'Required' },
  page: { bn: 'পাতা', en: 'Page' },
  of: { bn: 'এর', en: 'of' },
  all: { bn: 'সব', en: 'All' },
  today: { bn: 'আজ', en: 'Today' },
  thisWeek: { bn: 'এই সপ্তাহ', en: 'This week' },
  thisMonth: { bn: 'এই মাস', en: 'This month' },
  thisYear: { bn: 'এই বছর', en: 'This year' },
  custom: { bn: 'কাস্টম', en: 'Custom' },
  from: { bn: 'থেকে', en: 'From' },
  to: { bn: 'পর্যন্ত', en: 'To' },
  apply: { bn: 'প্রয়োগ', en: 'Apply' },

  // Dashboard
  dashboardTodaySales: { bn: 'আজকের বিক্রয়', en: "Today's Sales" },
  dashboardTodayPurchases: { bn: 'আজকের ক্রয়', en: "Today's Purchases" },
  dashboardTodayExpenses: { bn: 'আজকের খরচ', en: "Today's Expenses" },
  dashboardPurchases: { bn: 'আজকের ক্রয়', en: "Today's Purchases" },
  dashboardGrossProfit: { bn: 'মোট মুনাফা', en: 'Gross Profit' },
  dashboardNetProfit: { bn: 'নিট মুনাফা', en: 'Net Profit' },
  dashboardReceivables: { bn: 'গ্রাহক বাকি', en: 'Receivables' },
  dashboardPayables: { bn: 'সরবরাহকারী পাওনা', en: 'Payables' },
  dashboardCash: { bn: 'নগদ ও ব্যাংক', en: 'Cash & Bank' },
  dashboardStockValue: { bn: 'স্টকের মূল্য', en: 'Stock Value' },
  dashboardProducts: { bn: 'পণ্য সংখ্যা', en: 'Products' },
  dashboardLowStock: { bn: 'কম স্টক', en: 'Low Stock' },
  dashboardOutOfStock: { bn: 'স্টক শেষ', en: 'Out of Stock' },
  dashboardRecentSales: { bn: 'সাম্প্রতিক বিক্রয়', en: 'Recent Sales' },
  dashboardAlerts: { bn: 'সতর্কতা', en: 'Alerts' },
  dashboardQuickActions: { bn: 'দ্রুত কাজ', en: 'Quick Actions' },

  // POS
  posSearchPlaceholder: { bn: 'পণ্যের নাম, এসকেইউ বা বারকোড স্ক্যান করুন', en: 'Search name, SKU or scan barcode' },
  posCart: { bn: 'কার্ট', en: 'Cart' },
  posEmptyCart: { bn: 'কার্ট খালি', en: 'Cart is empty' },
  posEmptyCartHint: { bn: 'পণ্য যোগ করতে টাইল ক্লিক করুন বা বারকোড স্ক্যান করুন।', en: 'Click a product tile or scan a barcode.' },
  posComplete: { bn: 'বিক্রয় সম্পন্ন করুন', en: 'Complete Sale' },
  posClear: { bn: 'কার্ট খালি করুন', en: 'Clear Cart' },
  posHold: { bn: 'হোল্ড', en: 'Hold' },
  posCustomer: { bn: 'গ্রাহক', en: 'Customer' },
  posWalkIn: { bn: 'সাধারণ ক্রেতা', en: 'Walk-in' },
  posPayment: { bn: 'পেমেন্ট', en: 'Payment' },
  posPaidAmount: { bn: 'পরিশোধিত টাকা', en: 'Amount Paid' },
  posQuickCash: { bn: 'দ্রুত নগদ', en: 'Quick Cash' },
  posInvoiceDiscount: { bn: 'ইনভয়েস ছাড়', en: 'Invoice Discount' },
  posStockLeft: { bn: 'স্টক', en: 'stock' },
  posShortcuts: { bn: 'শর্টকাট: F2 সার্চ · F4 সম্পন্ন · Esc ক্লিয়ার', en: 'Shortcuts: F2 search · F4 complete · Esc clear' },

  // Products
  productName: { bn: 'পণ্যের নাম', en: 'Product name' },
  productNameBn: { bn: 'পণ্যের নাম (বাংলা)', en: 'Product name (Bengali)' },
  sku: { bn: 'এসকেইউ', en: 'SKU' },
  barcode: { bn: 'বারকোড', en: 'Barcode' },
  category: { bn: 'ক্যাটাগরি', en: 'Category' },
  brand: { bn: 'ব্র্যান্ড', en: 'Brand' },
  unit: { bn: 'একক', en: 'Unit' },
  purchasePrice: { bn: 'ক্রয়মূল্য', en: 'Purchase price' },
  salePrice: { bn: 'বিক্রয়মূল্য', en: 'Sale price' },
  wholesalePrice: { bn: 'পাইকারি মূল্য', en: 'Wholesale price' },
  stock: { bn: 'স্টক', en: 'Stock' },
  minStock: { bn: 'সর্বনিম্ন স্টক', en: 'Minimum stock' },
  addProduct: { bn: 'নতুন পণ্য', en: 'New Product' },
  openingStock: { bn: 'প্রারম্ভিক স্টক যোগ', en: 'Add Opening Stock' },
  adjustStock: { bn: 'স্টক সমন্বয়', en: 'Adjust Stock' },
  newStockQty: { bn: 'নতুন পরিমাণ', en: 'New quantity' },
  reason: { bn: 'কারণ', en: 'Reason' },

  // Sales
  invoiceNo: { bn: 'ইনভয়েস নং', en: 'Invoice No' },
  customer: { bn: 'গ্রাহক', en: 'Customer' },
  view: { bn: 'দেখুন', en: 'View' },
  void: { bn: 'বাতিল করুন', en: 'Void' },
  return: { bn: 'ফেরত', en: 'Return' },
  voidReason: { bn: 'বাতিলের কারণ', en: 'Void reason' },
  status: { bn: 'অবস্থা', en: 'Status' },
  completed: { bn: 'সম্পন্ন', en: 'Completed' },
  voided: { bn: 'বাতিল', en: 'Voided' },

  // Purchases
  purchaseNo: { bn: 'ক্রয় নং', en: 'Purchase No' },
  supplier: { bn: 'সরবরাহকারী', en: 'Supplier' },
  newPurchase: { bn: 'নতুন ক্রয়', en: 'New Purchase' },
  additionalCost: { bn: 'অতিরিক্ত খরচ', en: 'Additional cost' },
  supplierRef: { bn: 'সরবরাহকারী চালান নং', en: 'Supplier invoice ref' },
  paySupplier: { bn: 'সরবরাহকারীকে পরিশোধ', en: 'Pay supplier' },
  receivePayment: { bn: 'টাকা গ্রহণ', en: 'Receive payment' },

  // Expenses
  expenseCategory: { bn: 'খরচের ধরন', en: 'Expense category' },
  payee: { bn: 'প্রাপক', en: 'Payee' },
  newExpense: { bn: 'নতুন খরচ', en: 'New Expense' },
  voucherNo: { bn: 'ভাউচার নং', en: 'Voucher No' },

  // Reports
  reportTitle: { bn: 'রিপোর্ট', en: 'Reports' },
  reportGenerate: { bn: 'রিপোর্ট দেখুন', en: 'Generate' },
  exportCsv: { bn: 'CSV', en: 'CSV' },
  exportXlsx: { bn: 'এক্সেল', en: 'Excel' },
  exportPdf: { bn: 'PDF', en: 'PDF' },

  // Settings
  businessInfo: { bn: 'ব্যবসার তথ্য', en: 'Business information' },
  businessName: { bn: 'ব্যবসার নাম', en: 'Business name' },
  vatRegNo: { bn: 'ভ্যাট নিবন্ধন নং', en: 'VAT registration no' },
  invoiceFooter: { bn: 'ইনভয়েসের নিচের লেখা', en: 'Invoice footer' },
  printing: { bn: 'প্রিন্টিং', en: 'Printing' },
  printerName: { bn: 'প্রিন্টার', en: 'Printer' },
  paperWidth: { bn: 'রশিদের প্রস্থ', en: 'Receipt width' },
  testPrint: { bn: 'টেস্ট প্রিন্ট', en: 'Test print' },
  inventorySettings: { bn: 'স্টক সেটিংস', en: 'Inventory settings' },
  allowNegative: { bn: 'স্টক শেষ হলেও বিক্রয় অনুমোদন', en: 'Allow selling with no stock' },
  taxEnabled: { bn: 'ভ্যাট চালু', en: 'Enable VAT' },
  taxRate: { bn: 'ভ্যাটের হার (%)', en: 'VAT rate (%)' },
  language: { bn: 'ভাষা', en: 'Language' },
  backupSettings: { bn: 'ব্যাকআপ সেটিংস', en: 'Backup settings' },
  autoBackup: { bn: 'স্বয়ংক্রিয় ব্যাকআপ', en: 'Automatic backup' },
  backupLocation: { bn: 'ব্যাকআপ ফোল্ডার', en: 'Backup folder' },
  backupNow: { bn: 'এখনই ব্যাকআপ নিন', en: 'Back up now' },
  restoreBackup: { bn: 'ব্যাকআপ থেকে পুনরুদ্ধার', en: 'Restore from backup' },
  verifyBackup: { bn: 'ব্যাকআপ যাচাই', en: 'Verify backup' },

  // Licence
  licenseStatus: { bn: 'লাইসেন্স অবস্থা', en: 'Licence status' },
  licenseActive: { bn: 'সক্রিয়', en: 'Active' },
  licenseInactive: { bn: 'সক্রিয় নয়', en: 'Not activated' },
  activateLicense: { bn: 'লাইসেন্স ফাইল থেকে সক্রিয় করুন', en: 'Activate from licence file' },
  organization: { bn: 'প্রতিষ্ঠানের নাম', en: 'Organization' },
  deviceId: { bn: 'ডিভাইস আইডি', en: 'Device ID' },

  // Misc
  about: { bn: 'পরিচিতি', en: 'About' },
  version: { bn: 'সংস্করণ', en: 'Version' },
  developer: { bn: 'প্রস্তুতকারক', en: 'Developed by' },
  contact: { bn: 'যোগাযোগ', en: 'Contact' },
  dataLocation: { bn: 'ডাটা ফোল্ডার', en: 'Data folder' },
  healthCheck: { bn: 'সিস্টেম যাচাই', en: 'Health check' },
  openFolder: { bn: 'ফোল্ডার খুলুন', en: 'Open folder' },
} satisfies Record<string, Entry>;

export type StringKey = keyof typeof strings;

export function translate(key: StringKey, lang: Lang): string {
  const entry = strings[key] as Entry | undefined;
  if (!entry) return key;
  return lang === 'bn' ? entry.bn : entry.en;
}

/** Pick the display name for a record that may have Bengali and English names. */
export function displayName(
  lang: Lang,
  bengali: string | null | undefined,
  english: string | null | undefined,
): string {
  if (lang === 'bn' && bengali && bengali.trim() !== '') return bengali;
  return english ?? bengali ?? '';
}
