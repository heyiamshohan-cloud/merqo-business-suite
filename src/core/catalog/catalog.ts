/**
 * Catalogue: categories, brands, units, products and barcodes.
 *
 * Deletion policy: nothing referenced by a transaction is ever hard-deleted.
 * Products and categories are archived (soft state) so historical invoices,
 * stock movements and reports keep resolving their original names.
 */
import { AppError, BusinessRuleError, NotFoundError, ValidationError } from '../foundation/errors';
import { newId } from '../foundation/ids';
import { toQtyMilliOrZero } from '../foundation/money';
import type { Ctx } from '../kernel';
import type { BrandRow, CategoryRow, ProductRow, UnitRow } from '../domain/types';
import { nextSequence } from '../services/settings';

function requireText(value: string | undefined | null, label: string, labelBn: string): string {
  const v = (value ?? '').trim();
  if (v === '') throw new ValidationError(`${label} is required`, `${labelBn} আবশ্যক।`);
  return v;
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------
export interface CreateCategoryInput {
  name: string;
  nameBn?: string | null;
  parentId?: string | null;
}

export function createCategory(ctx: Ctx, input: CreateCategoryInput): CategoryRow {
  const name = requireText(input.name, 'Category name', 'ক্যাটাগরি নাম');
  const at = ctx.clock.nowIso();
  const exists = ctx.db.get<{ id: string }>(
    'SELECT id FROM categories WHERE name = ? COLLATE NOCASE',
    [name],
  );
  if (exists) {
    throw new AppError(`Category "${name}" already exists`, {
      code: 'DUPLICATE',
      messageBn: 'এই ক্যাটাগরি আগেই তৈরি করা হয়েছে।',
      details: { name },
    });
  }
  const id = newId();
  ctx.db.run(
    `INSERT INTO categories (id, name, name_bn, parent_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?)`,
    [id, name, input.nameBn ?? null, input.parentId ?? null, at, at],
  );
  return ctx.db.get<CategoryRow>('SELECT * FROM categories WHERE id = ?', [id]) as CategoryRow;
}

export function updateCategory(
  ctx: Ctx,
  id: string,
  patch: { name?: string; nameBn?: string | null },
): CategoryRow {
  const existing = ctx.db.get<CategoryRow>('SELECT * FROM categories WHERE id = ?', [id]);
  if (!existing) throw new NotFoundError('Category not found', 'ক্যাটাগরি পাওয়া যায়নি।');
  const name = patch.name !== undefined ? requireText(patch.name, 'Category name', 'ক্যাটাগরি নাম') : existing.name;
  const dup = ctx.db.get<{ id: string }>(
    'SELECT id FROM categories WHERE name = ? COLLATE NOCASE AND id != ?',
    [name, id],
  );
  if (dup) {
    throw new AppError(`Category "${name}" already exists`, {
      code: 'DUPLICATE',
      messageBn: 'এই ক্যাটাগরি আগেই তৈরি করা হয়েছে।',
    });
  }
  ctx.db.run('UPDATE categories SET name = ?, name_bn = ?, updated_at = ? WHERE id = ?', [
    name,
    patch.nameBn !== undefined ? patch.nameBn : existing.name_bn,
    ctx.clock.nowIso(),
    id,
  ]);
  return ctx.db.get<CategoryRow>('SELECT * FROM categories WHERE id = ?', [id]) as CategoryRow;
}

export interface CategoryWithCount extends CategoryRow {
  product_count: number;
}

export function listCategories(ctx: Ctx, includeArchived = false): CategoryWithCount[] {
  return ctx.db.all<CategoryWithCount>(
    `SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id AND p.status = 'active') AS product_count
       FROM categories c
      WHERE ${includeArchived ? '1=1' : "c.status = 'active'"}
      ORDER BY c.name COLLATE NOCASE`,
  );
}

export function archiveCategory(ctx: Ctx, id: string): void {
  const count = ctx.db.count('products', 'category_id = ? AND status = ?', [id, 'active']);
  if (count > 0) {
    throw new BusinessRuleError(
      'CONFLICT',
      `Category still contains ${count} active product(s). Move them first.`,
      'এই ক্যাটাগরিতে এখনো পণ্য আছে। আগে পণ্যগুলো অন্য ক্যাটাগরিতে সরান।',
      { categoryId: id, productCount: count },
    );
  }
  ctx.db.run("UPDATE categories SET status = 'archived', updated_at = ? WHERE id = ?", [
    ctx.clock.nowIso(),
    id,
  ]);
}

export function restoreCategory(ctx: Ctx, id: string): void {
  ctx.db.run("UPDATE categories SET status = 'active', updated_at = ? WHERE id = ?", [
    ctx.clock.nowIso(),
    id,
  ]);
}

// ---------------------------------------------------------------------------
// Brands
// ---------------------------------------------------------------------------
export function createBrand(ctx: Ctx, name: string): BrandRow {
  const clean = requireText(name, 'Brand name', 'ব্র্যান্ড নাম');
  const dup = ctx.db.get<{ id: string }>('SELECT id FROM brands WHERE name = ? COLLATE NOCASE', [
    clean,
  ]);
  if (dup) {
    throw new AppError(`Brand "${clean}" already exists`, {
      code: 'DUPLICATE',
      messageBn: 'এই ব্র্যান্ড আগেই তৈরি করা হয়েছে।',
    });
  }
  const id = newId();
  const at = ctx.clock.nowIso();
  ctx.db.run(
    `INSERT INTO brands (id, name, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)`,
    [id, clean, at, at],
  );
  return ctx.db.get<BrandRow>('SELECT * FROM brands WHERE id = ?', [id]) as BrandRow;
}

export function listBrands(ctx: Ctx): BrandRow[] {
  return ctx.db.all<BrandRow>("SELECT * FROM brands WHERE status = 'active' ORDER BY name COLLATE NOCASE");
}

export function listUnits(ctx: Ctx): UnitRow[] {
  return ctx.db.all<UnitRow>('SELECT * FROM units ORDER BY name');
}

export function getDefaultUnitId(ctx: Ctx): string | null {
  const row = ctx.db.get<{ id: string }>("SELECT id FROM units WHERE short_name = 'pcs'");
  return row?.id ?? null;
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------
export interface ProductInput {
  sku?: string | null;
  name: string;
  nameBn?: string | null;
  categoryId?: string | null;
  brandId?: string | null;
  unitId?: string | null;
  purchasePrice: number;
  salePrice: number;
  wholesalePrice?: number;
  minStock?: number;
  maxStock?: number | null;
  taxRateBp?: number;
  trackStock?: boolean;
  description?: string | null;
  notes?: string | null;
  barcodes?: string[];
  openingQty?: string | number;
}

export interface ProductWithStock extends ProductRow {
  stock_qty: number;
  stock_value: number;
  unit_cost: number;
  barcode_list: string | null;
}

const PRODUCT_SELECT = `
  SELECT p.*,
         c.name AS category_name,
         b.name AS brand_name,
         u.short_name AS unit_short,
         u.allow_decimal AS unit_allow_decimal,
         COALESCE(sl.qty, 0) AS stock_qty,
         COALESCE(sl.value, 0) AS stock_value,
         CASE WHEN COALESCE(sl.qty,0) = 0 THEN 0
              ELSE CAST(ROUND(COALESCE(sl.value,0) * 1000.0 / sl.qty) AS INTEGER) END AS unit_cost,
         (SELECT GROUP_CONCAT(pb.code, ',') FROM product_barcodes pb WHERE pb.product_id = p.id) AS barcode_list
    FROM products p
    LEFT JOIN categories c ON c.id = p.category_id
    LEFT JOIN brands b ON b.id = p.brand_id
    LEFT JOIN units u ON u.id = p.unit_id
    LEFT JOIN stock_levels sl ON sl.product_id = p.id
`;

function validateProductInput(input: ProductInput): void {
  requireText(input.name, 'Product name', 'পণ্যের নাম');
  if (!Number.isInteger(input.purchasePrice) || input.purchasePrice < 0) {
    throw new ValidationError('Purchase price must be zero or more', 'ক্রয়মূল্য শূন্য বা তার বেশি হতে হবে।');
  }
  if (!Number.isInteger(input.salePrice) || input.salePrice < 0) {
    throw new ValidationError('Sale price must be zero or more', 'বিক্রয়মূল্য শূন্য বা তার বেশি হতে হবে।');
  }
  if (input.taxRateBp !== undefined && (input.taxRateBp < 0 || input.taxRateBp > 10_000)) {
    throw new ValidationError('Tax rate must be between 0% and 100%', 'ভ্যাটের হার ০% থেকে ১০০% এর মধ্যে হতে হবে।');
  }
  if (input.minStock !== undefined && input.minStock < 0) {
    throw new ValidationError('Minimum stock cannot be negative', 'সর্বনিম্ন স্টক ঋণাত্মক হতে পারে না।');
  }
}

export function createProduct(ctx: Ctx, input: ProductInput): ProductWithStock {
  validateProductInput(input);
  const at = ctx.clock.nowIso();
  return ctx.db.transaction(() => {
    let sku = (input.sku ?? '').trim();
    if (sku === '') {
      sku = nextSequence(ctx.db, 'product').formatted;
    }
    const dupSku = ctx.db.get<{ id: string }>('SELECT id FROM products WHERE sku = ?', [sku]);
    if (dupSku) {
      throw new AppError(`SKU "${sku}" is already used by another product`, {
        code: 'DUPLICATE',
        messageBn: 'এই এসকেইউ আগেই ব্যবহার করা হয়েছে।',
        details: { sku },
      });
    }

    const id = newId();
    const unitId = input.unitId ?? getDefaultUnitId(ctx);
    ctx.db.run(
      `INSERT INTO products
        (id, sku, name, name_bn, category_id, brand_id, unit_id, purchase_price, sale_price,
         wholesale_price, min_stock, max_stock, tax_rate_bp, track_stock, description, notes,
         supplier_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'active', ?, ?)`,
      [
        id,
        sku,
        input.name.trim(),
        input.nameBn ?? null,
        input.categoryId ?? null,
        input.brandId ?? null,
        unitId,
        input.purchasePrice,
        input.salePrice,
        input.wholesalePrice ?? 0,
        input.minStock ?? 0,
        input.maxStock ?? null,
        input.taxRateBp ?? 0,
        input.trackStock === false ? 0 : 1,
        input.description ?? null,
        input.notes ?? null,
        at,
        at,
      ],
    );

    for (const barcode of input.barcodes ?? []) {
      const code = barcode.trim();
      if (code === '') continue;
      addBarcode(ctx, { productId: id, code, kind: code.length > 13 ? 'qr' : 'barcode' });
    }

    ctx.db.run('INSERT INTO stock_levels (product_id, qty, value, updated_at) VALUES (?, 0, 0, ?)', [
      id,
      at,
    ]);

    return getProduct(ctx, id);
  });
}

export interface UpdateProductInput extends Partial<Omit<ProductInput, 'openingQty'>> {
  id: string;
}

export function updateProduct(ctx: Ctx, input: UpdateProductInput): ProductWithStock {
  const existing = ctx.db.get<ProductRow>('SELECT * FROM products WHERE id = ?', [input.id]);
  if (!existing) throw new NotFoundError('Product not found', 'পণ্যটি পাওয়া যায়নি।', { id: input.id });
  if (input.name !== undefined) requireText(input.name, 'Product name', 'পণ্যের নাম');
  if (input.salePrice !== undefined && (input.salePrice < 0 || !Number.isInteger(input.salePrice))) {
    throw new ValidationError('Sale price must be a positive whole amount', 'বিক্রয়মূল্য সঠিকভাবে দিন।');
  }
  return ctx.db.transaction(() => {
    if (input.sku !== undefined) {
      const sku = requireText(input.sku, 'SKU', 'এসকেইউ');
      const dup = ctx.db.get<{ id: string }>('SELECT id FROM products WHERE sku = ? AND id != ?', [
        sku,
        input.id,
      ]);
      if (dup) {
        throw new AppError(`SKU "${sku}" is already used by another product`, {
          code: 'DUPLICATE',
          messageBn: 'এই এসকেইউ আগেই ব্যবহার করা হয়েছে।',
        });
      }
    }
    const fields: string[] = [];
    const params: Array<string | number | null> = [];
    const map: Array<[keyof UpdateProductInput, string, (v: unknown) => string | number | null]> = [
      ['sku', 'sku', (v) => String(v).trim()],
      ['name', 'name', (v) => String(v).trim()],
      ['nameBn', 'name_bn', (v) => (v === null || v === '' ? null : String(v))],
      ['categoryId', 'category_id', (v) => (v as string | null) ?? null],
      ['brandId', 'brand_id', (v) => (v as string | null) ?? null],
      ['unitId', 'unit_id', (v) => (v as string | null) ?? null],
      ['purchasePrice', 'purchase_price', (v) => Number(v)],
      ['salePrice', 'sale_price', (v) => Number(v)],
      ['wholesalePrice', 'wholesale_price', (v) => Number(v)],
      ['minStock', 'min_stock', (v) => Number(v)],
      ['maxStock', 'max_stock', (v) => (v === null ? null : Number(v))],
      ['taxRateBp', 'tax_rate_bp', (v) => Number(v)],
      ['trackStock', 'track_stock', (v) => (v ? 1 : 0)],
      ['description', 'description', (v) => (v === null || v === '' ? null : String(v))],
      ['notes', 'notes', (v) => (v === null || v === '' ? null : String(v))],
    ];
    for (const [key, column, coerce] of map) {
      const value = input[key];
      if (value === undefined) continue;
      fields.push(`${column} = ?`);
      params.push(coerce(value));
    }
    if (fields.length > 0) {
      fields.push('updated_at = ?');
      params.push(ctx.clock.nowIso());
      params.push(input.id);
      ctx.db.run(`UPDATE products SET ${fields.join(', ')} WHERE id = ?`, params);
    }
    for (const barcode of input.barcodes ?? []) {
      const code = barcode.trim();
      if (code === '') continue;
      const existingBarcode = ctx.db.get<{ product_id: string }>(
        'SELECT product_id FROM product_barcodes WHERE code = ?',
        [code],
      );
      if (existingBarcode && existingBarcode.product_id !== input.id) {
        throw new AppError(`Barcode "${code}" already belongs to another product`, {
          code: 'DUPLICATE',
          messageBn: 'এই বারকোড অন্য পণ্যে ব্যবহৃত হচ্ছে।',
          details: { code },
        });
      }
      if (!existingBarcode) {
        addBarcode(ctx, {
          productId: input.id,
          code,
          kind: code.length > 13 ? 'qr' : 'barcode',
        });
      }
    }
    return getProduct(ctx, input.id);
  });
}

export function getProduct(ctx: Ctx, id: string): ProductWithStock {
  const row = ctx.db.get<ProductWithStock>(`${PRODUCT_SELECT} WHERE p.id = ?`, [id]);
  if (!row) throw new NotFoundError('Product not found', 'পণ্যটি পাওয়া যায়নি।', { id });
  return row;
}

export interface ProductQuery {
  search?: string;
  categoryId?: string | null;
  brandId?: string | null;
  status?: 'active' | 'archived' | 'all';
  lowStock?: boolean;
  outOfStock?: boolean;
  page?: number;
  pageSize?: number;
  sortBy?: 'name' | 'sku' | 'stock' | 'sale_price' | 'created_at';
  sortDir?: 'asc' | 'desc';
}

export function searchProducts(
  ctx: Ctx,
  q: ProductQuery = {},
): { rows: ProductWithStock[]; total: number; page: number; pageSize: number; totalPages: number } {
  const where: string[] = [];
  const params: Array<string | number> = [];
  const status = q.status ?? 'active';
  if (status !== 'all') {
    where.push('p.status = ?');
    params.push(status);
  }
  if (q.categoryId) {
    where.push('p.category_id = ?');
    params.push(q.categoryId);
  }
  if (q.brandId) {
    where.push('p.brand_id = ?');
    params.push(q.brandId);
  }
  if (q.search && q.search.trim() !== '') {
    const term = `%${q.search.trim().toLowerCase()}%`;
    where.push(
      `(LOWER(p.name) LIKE ? OR LOWER(COALESCE(p.name_bn,'')) LIKE ? OR LOWER(p.sku) LIKE ?
        OR EXISTS (SELECT 1 FROM product_barcodes pb WHERE pb.product_id = p.id AND pb.code = ?))`,
    );
    params.push(term, term, term, q.search.trim());
  }
  if (q.lowStock) {
    where.push('COALESCE(sl.qty,0) <= CASE WHEN p.min_stock > 0 THEN p.min_stock ELSE 5 END');
    where.push('p.track_stock = 1');
  }
  if (q.outOfStock) {
    where.push('COALESCE(sl.qty,0) <= 0');
    where.push('p.track_stock = 1');
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = ctx.db.sum(
    `SELECT COUNT(*) AS v FROM products p LEFT JOIN stock_levels sl ON sl.product_id = p.id ${whereSql}`,
    params,
  );

  const sortColumn =
    q.sortBy === 'sku'
      ? 'p.sku'
      : q.sortBy === 'stock'
        ? 'COALESCE(sl.qty,0)'
        : q.sortBy === 'sale_price'
          ? 'p.sale_price'
          : q.sortBy === 'created_at'
            ? 'p.created_at'
            : 'p.name COLLATE NOCASE';
  const dir = q.sortDir === 'desc' ? 'DESC' : 'ASC';
  const page = Math.max(1, q.page ?? 1);
  const pageSize = Math.min(Math.max(1, q.pageSize ?? 50), 500);

  const rows = ctx.db.all<ProductWithStock>(
    `${PRODUCT_SELECT} ${whereSql} ORDER BY ${sortColumn} ${dir} LIMIT ? OFFSET ?`,
    [...params, pageSize, (page - 1) * pageSize],
  );
  return {
    rows,
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

export function archiveProduct(ctx: Ctx, id: string): void {
  const product = ctx.db.get<ProductRow>('SELECT * FROM products WHERE id = ?', [id]);
  if (!product) throw new NotFoundError('Product not found', 'পণ্যটি পাওয়া যায়নি।');
  ctx.db.run("UPDATE products SET status = 'archived', updated_at = ? WHERE id = ?", [
    ctx.clock.nowIso(),
    id,
  ]);
}

export function restoreProduct(ctx: Ctx, id: string): void {
  ctx.db.run("UPDATE products SET status = 'active', updated_at = ? WHERE id = ?", [
    ctx.clock.nowIso(),
    id,
  ]);
}

/**
 * Hard delete is only allowed for products with no commercial history.
 * Anything with stock, sales or purchases must be archived instead.
 */
export function deleteProduct(ctx: Ctx, id: string): void {
  const product = ctx.db.get<ProductRow>('SELECT * FROM products WHERE id = ?', [id]);
  if (!product) throw new NotFoundError('Product not found', 'পণ্যটি পাওয়া যায়নি।');
  const stock = ctx.db.get<{ qty: number }>('SELECT qty FROM stock_levels WHERE product_id = ?', [id]);
  if ((stock?.qty ?? 0) !== 0) {
    throw new BusinessRuleError(
      'CONFLICT',
      'Cannot delete a product that still has stock. Archive it instead.',
      'স্টক থাকা পণ্য মুছে ফেলা যাবে না। আর্কাইভ করুন।',
    );
  }
  const refs = ctx.db.sum(
    `SELECT (SELECT COUNT(*) FROM sale_lines WHERE product_id = ?)
          + (SELECT COUNT(*) FROM purchase_lines WHERE product_id = ?)
          + (SELECT COUNT(*) FROM stock_moves WHERE product_id = ?) AS v`,
    [id, id, id],
  );
  if (refs > 0) {
    throw new BusinessRuleError(
      'CONFLICT',
      'This product appears in transactions and cannot be deleted. Archive it instead.',
      'এই পণ্যটি লেনদেনে ব্যবহৃত হয়েছে, তাই মুছে ফেলা যাবে না। আর্কাইভ করুন।',
      { references: refs },
    );
  }
  ctx.db.transaction(() => {
    ctx.db.run('DELETE FROM product_barcodes WHERE product_id = ?', [id]);
    ctx.db.run('DELETE FROM stock_levels WHERE product_id = ?', [id]);
    ctx.db.run('DELETE FROM products WHERE id = ?', [id]);
  });
}

// ---------------------------------------------------------------------------
// Barcodes / QR
// ---------------------------------------------------------------------------
export interface BarcodeRow {
  id: string;
  product_id: string;
  code: string;
  kind: 'barcode' | 'qr';
  is_primary: number;
  created_at: string;
}

export function addBarcode(
  ctx: Ctx,
  input: { productId: string; code: string; kind?: 'barcode' | 'qr'; isPrimary?: boolean },
): BarcodeRow {
  const code = requireText(input.code, 'Barcode', 'বারকোড');
  const owner = ctx.db.get<{ product_id: string }>(
    'SELECT product_id FROM product_barcodes WHERE code = ?',
    [code],
  );
  if (owner) {
    throw new AppError(`Barcode "${code}" is already assigned to another product`, {
      code: 'DUPLICATE',
      messageBn: 'এই বারকোড অন্য পণ্যে ব্যবহৃত হচ্ছে।',
      details: { code, productId: owner.product_id },
    });
  }
  const id = newId();
  ctx.db.run(
    `INSERT INTO product_barcodes (id, product_id, code, kind, is_primary, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, input.productId, code, input.kind ?? 'barcode', input.isPrimary ? 1 : 0, ctx.clock.nowIso()],
  );
  return ctx.db.get<BarcodeRow>('SELECT * FROM product_barcodes WHERE id = ?', [id]) as BarcodeRow;
}

export function removeBarcode(ctx: Ctx, barcodeId: string): void {
  ctx.db.run('DELETE FROM product_barcodes WHERE id = ?', [barcodeId]);
}

export function listBarcodes(ctx: Ctx, productId: string): BarcodeRow[] {
  return ctx.db.all<BarcodeRow>(
    'SELECT * FROM product_barcodes WHERE product_id = ? ORDER BY is_primary DESC, created_at',
    [productId],
  );
}

/** Resolve a scanned barcode or QR payload to a product (POS path). */
export function findByBarcode(ctx: Ctx, code: string): ProductWithStock | undefined {
  const trimmed = (code ?? '').trim();
  if (trimmed === '') return undefined;
  const row = ctx.db.get<{ product_id: string }>(
    'SELECT product_id FROM product_barcodes WHERE code = ?',
    [trimmed],
  );
  if (!row) {
    const bySku = ctx.db.get<{ id: string }>('SELECT id FROM products WHERE sku = ?', [trimmed]);
    if (!bySku) return undefined;
    return getProduct(ctx, bySku.id);
  }
  return getProduct(ctx, row.product_id);
}
