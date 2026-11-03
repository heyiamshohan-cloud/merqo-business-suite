/**
 * Chart of accounts.
 *
 * MERQO posts real double-entry journals. Account codes are stable system
 * identifiers — the business may rename accounts but must not change codes,
 * because posting rules reference them.
 */

export const ACC = {
  CASH: '1000',
  BANK: '1010',
  MFS: '1020', // bKash / Nagad / Rocket settlement account
  CARD_CLEARING: '1030',
  AR: '1100',
  INVENTORY: '1200',
  VAT_INPUT: '1300',

  AP: '2000',
  VAT_PAYABLE: '2100',
  CUSTOMER_ADVANCE: '2200',

  CAPITAL: '3000',
  OPENING_BALANCE_EQUITY: '3100',
  RETAINED_EARNINGS: '3200',
  DRAWINGS: '3300',

  SALES: '4000',
  SALES_DISCOUNT: '4010',
  SALES_RETURNS: '4020',
  OTHER_INCOME: '4900',

  COGS: '5000',
  INVENTORY_ADJUSTMENT: '5100',
  CASH_SHORT_OVER: '5200',

  EXP_RENT: '6000',
  EXP_ELECTRICITY: '6010',
  EXP_INTERNET: '6020',
  EXP_SALARY: '6030',
  EXP_TRANSPORT: '6040',
  EXP_PACKAGING: '6050',
  EXP_MAINTENANCE: '6060',
  EXP_OTHER: '6090',
} as const;

export type AccountCode = (typeof ACC)[keyof typeof ACC];

export type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';

export interface AccountDefinition {
  code: string;
  name: string;
  nameBn: string;
  type: AccountType;
  subtype?: string;
  isSystem?: boolean;
}

/** Payment methods the POS/payment screens can use, mapped to settlement accounts. */
export interface PaymentMethodDefinition {
  key: string;
  name: string;
  nameBn: string;
  accountCode: string;
}

export const PAYMENT_METHODS: PaymentMethodDefinition[] = [
  { key: 'cash', name: 'Cash', nameBn: 'নগদ', accountCode: ACC.CASH },
  { key: 'bkash', name: 'bKash', nameBn: 'বিকাশ', accountCode: ACC.MFS },
  { key: 'nagad', name: 'Nagad', nameBn: 'নগদ (Nagad)', accountCode: ACC.MFS },
  { key: 'rocket', name: 'Rocket', nameBn: 'রকেট', accountCode: ACC.MFS },
  { key: 'card', name: 'Card', nameBn: 'কার্ড', accountCode: ACC.CARD_CLEARING },
  { key: 'bank', name: 'Bank transfer', nameBn: 'ব্যাংক ট্রান্সফার', accountCode: ACC.BANK },
];

export function paymentMethodAccountCode(method: string): string {
  const found = PAYMENT_METHODS.find((m) => m.key === method.toLowerCase());
  return found ? found.accountCode : ACC.CASH;
}

export const CHART_OF_ACCOUNTS: AccountDefinition[] = [
  { code: ACC.CASH, name: 'Cash in Hand', nameBn: 'হাতে নগদ', type: 'asset', subtype: 'current', isSystem: true },
  { code: ACC.BANK, name: 'Bank Account', nameBn: 'ব্যাংক হিসাব', type: 'asset', subtype: 'current', isSystem: true },
  { code: ACC.MFS, name: 'Mobile Financial Service', nameBn: 'মোবাইল ব্যাংকিং', type: 'asset', subtype: 'current', isSystem: true },
  { code: ACC.CARD_CLEARING, name: 'Card Settlement Receivable', nameBn: 'কার্ড সেটেলমেন্ট', type: 'asset', subtype: 'current', isSystem: true },
  { code: ACC.AR, name: 'Accounts Receivable (Customers)', nameBn: 'গ্রাহক বাকি (প্রাপ্য)', type: 'asset', subtype: 'receivable', isSystem: true },
  { code: ACC.INVENTORY, name: 'Inventory', nameBn: 'স্টক (মজুদ)', type: 'asset', subtype: 'inventory', isSystem: true },
  { code: ACC.VAT_INPUT, name: 'VAT Input (Receivable)', nameBn: 'ভ্যাট প্রাপ্য', type: 'asset', subtype: 'tax', isSystem: true },

  { code: ACC.AP, name: 'Accounts Payable (Suppliers)', nameBn: 'সরবরাহকারী পাওনা (দেয়)', type: 'liability', subtype: 'payable', isSystem: true },
  { code: ACC.VAT_PAYABLE, name: 'VAT Payable', nameBn: 'ভ্যাট দেয়', type: 'liability', subtype: 'tax', isSystem: true },
  { code: ACC.CUSTOMER_ADVANCE, name: 'Customer Advance', nameBn: 'গ্রাহকের অগ্রিম', type: 'liability', subtype: 'current', isSystem: true },

  { code: ACC.CAPITAL, name: 'Owner Capital', nameBn: 'মালিকের মূলধন', type: 'equity', subtype: 'capital', isSystem: true },
  { code: ACC.OPENING_BALANCE_EQUITY, name: 'Opening Balance Equity', nameBn: 'প্রারম্ভিক ব্যালেন্স সমন্বয়', type: 'equity', subtype: 'opening', isSystem: true },
  { code: ACC.RETAINED_EARNINGS, name: 'Retained Earnings', nameBn: 'সঞ্চিত মুনাফা', type: 'equity', subtype: 'retained', isSystem: true },
  { code: ACC.DRAWINGS, name: 'Owner Drawings', nameBn: 'মালিকের উত্তোলন', type: 'equity', subtype: 'drawings', isSystem: true },

  { code: ACC.SALES, name: 'Sales Revenue', nameBn: 'বিক্রয় আয়', type: 'revenue', subtype: 'operating', isSystem: true },
  { code: ACC.SALES_DISCOUNT, name: 'Sales Discount', nameBn: 'বিক্রয় ছাড়', type: 'revenue', subtype: 'contra_revenue', isSystem: true },
  { code: ACC.SALES_RETURNS, name: 'Sales Returns', nameBn: 'বিক্রয় ফেরত', type: 'revenue', subtype: 'contra_revenue', isSystem: true },
  { code: ACC.OTHER_INCOME, name: 'Other Income', nameBn: 'অন্যান্য আয়', type: 'revenue', subtype: 'other', isSystem: true },

  { code: ACC.COGS, name: 'Cost of Goods Sold', nameBn: 'বিক্রীত পণ্যের ক্রয়মূল্য', type: 'expense', subtype: 'cogs', isSystem: true },
  { code: ACC.INVENTORY_ADJUSTMENT, name: 'Inventory Adjustment', nameBn: 'স্টক সমন্বয়', type: 'expense', subtype: 'adjustment', isSystem: true },
  { code: ACC.CASH_SHORT_OVER, name: 'Cash Short / Over', nameBn: 'নগদ ঘাটতি / উদ্বৃত্ত', type: 'expense', subtype: 'adjustment', isSystem: true },

  { code: ACC.EXP_RENT, name: 'Shop Rent', nameBn: 'দোকান ভাড়া', type: 'expense', subtype: 'operating_expense', isSystem: true },
  { code: ACC.EXP_ELECTRICITY, name: 'Electricity', nameBn: 'বিদ্যুৎ বিল', type: 'expense', subtype: 'operating_expense', isSystem: true },
  { code: ACC.EXP_INTERNET, name: 'Internet', nameBn: 'ইন্টারনেট বিল', type: 'expense', subtype: 'operating_expense', isSystem: true },
  { code: ACC.EXP_SALARY, name: 'Employee Salary', nameBn: 'কর্মচারী বেতন', type: 'expense', subtype: 'operating_expense', isSystem: true },
  { code: ACC.EXP_TRANSPORT, name: 'Transportation', nameBn: 'পরিবহন খরচ', type: 'expense', subtype: 'operating_expense', isSystem: true },
  { code: ACC.EXP_PACKAGING, name: 'Packaging', nameBn: 'প্যাকেজিং খরচ', type: 'expense', subtype: 'operating_expense', isSystem: true },
  { code: ACC.EXP_MAINTENANCE, name: 'Maintenance & Repair', nameBn: 'রক্ষণাবেক্ষণ ও মেরামত', type: 'expense', subtype: 'operating_expense', isSystem: true },
  { code: ACC.EXP_OTHER, name: 'Other Expenses', nameBn: 'অন্যান্য খরচ', type: 'expense', subtype: 'operating_expense', isSystem: true },
];

/** Expense categories created on a fresh installation. */
export const DEFAULT_EXPENSE_CATEGORIES: Array<{
  name: string;
  nameBn: string;
  accountCode: string;
}> = [
  { name: 'Shop Rent', nameBn: 'দোকান ভাড়া', accountCode: ACC.EXP_RENT },
  { name: 'Electricity', nameBn: 'বিদ্যুৎ বিল', accountCode: ACC.EXP_ELECTRICITY },
  { name: 'Internet', nameBn: 'ইন্টারনেট', accountCode: ACC.EXP_INTERNET },
  { name: 'Employee Salary', nameBn: 'কর্মচারী বেতন', accountCode: ACC.EXP_SALARY },
  { name: 'Transportation', nameBn: 'পরিবহন', accountCode: ACC.EXP_TRANSPORT },
  { name: 'Packaging', nameBn: 'প্যাকেজিং', accountCode: ACC.EXP_PACKAGING },
  { name: 'Maintenance', nameBn: 'রক্ষণাবেক্ষণ', accountCode: ACC.EXP_MAINTENANCE },
  { name: 'Other Expense', nameBn: 'অন্যান্য খরচ', accountCode: ACC.EXP_OTHER },
];

/** Units created on a fresh installation. */
export const DEFAULT_UNITS: Array<{
  name: string;
  nameBn: string;
  shortName: string;
  allowDecimal: boolean;
}> = [
  { name: 'Piece', nameBn: 'পিস', shortName: 'pcs', allowDecimal: false },
  { name: 'Kilogram', nameBn: 'কেজি', shortName: 'kg', allowDecimal: true },
  { name: 'Gram', nameBn: 'গ্রাম', shortName: 'gm', allowDecimal: true },
  { name: 'Litre', nameBn: 'লিটার', shortName: 'ltr', allowDecimal: true },
  { name: 'Millilitre', nameBn: 'মিলিলিটার', shortName: 'ml', allowDecimal: true },
  { name: 'Metre', nameBn: 'মিটার', shortName: 'mtr', allowDecimal: true },
  { name: 'Box', nameBn: 'বক্স', shortName: 'box', allowDecimal: false },
  { name: 'Pack', nameBn: 'প্যাকেট', shortName: 'pkt', allowDecimal: false },
  { name: 'Dozen', nameBn: 'ডজন', shortName: 'dzn', allowDecimal: false },
  { name: 'Bag', nameBn: 'বস্তা', shortName: 'bag', allowDecimal: true },
];

/** Accounts whose balances must never be negative in normal operation. */
export const DEBIT_NORMAL_TYPES: AccountType[] = ['asset', 'expense'];
