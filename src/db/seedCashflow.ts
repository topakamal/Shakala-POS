import type { Db } from './types'
import { nowMs } from '@/lib/datetime'

/**
 * Kategori cashflow bawaan yang **selalu dijamin ada** (dipanggil tiap boot &
 * setelah `resetLocalBusinessData`). 'Penjualan' = kategori sistem (`is_system=1`,
 * income) — tujuan otomatis pemasukan checkout ({@link file://./checkout.service.ts}
 * `CashflowCategoryRepository.systemSales`), tak bisa dihapus dari UI.
 */
export const DEFAULT_CASHFLOW_CATEGORIES: ReadonlyArray<{
  name: string
  type: 'income' | 'expense'
  isSystem: 0 | 1
}> = [
  { name: 'Penjualan', type: 'income', isSystem: 1 },
  { name: 'Modal / Setoran', type: 'income', isSystem: 0 },
  { name: 'Pendapatan Lain', type: 'income', isSystem: 0 },
  { name: 'Belanja Stok', type: 'expense', isSystem: 0 },
  { name: 'Gaji Karyawan', type: 'expense', isSystem: 0 },
  { name: 'Sewa Tempat', type: 'expense', isSystem: 0 },
  { name: 'Listrik & Air', type: 'expense', isSystem: 0 },
  { name: 'Operasional', type: 'expense', isSystem: 0 },
  { name: 'Lain-lain', type: 'expense', isSystem: 0 },
]

/** ID tetap supaya kategori bawaan yang dibuat di perangkat berbeda tetap
 * merujuk ke kategori yang sama saat cashflow disinkronkan. */
export function defaultCashflowCategoryId(name: string, type: 'income' | 'expense'): string {
  const key = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return `cashflow-default-${type}-${key}`
}

/**
 * Isi kategori cashflow default yang belum ada. **Idempotent by name**: kategori
 * yang namanya sudah ada (belum terhapus) dilewati, jadi aman dipanggil berulang
 * (tiap boot) tanpa bikin duplikat. Baris ditulis device-local (`dirty=0`, tanpa
 * baris `outbox`) sehingga recovery sync tidak mengantrekannya untuk di-push.
 * `db` bisa handle utama maupun tx migration (sama-sama `Db`).
 */
export async function seedDefaultCashflowCategories(db: Db): Promise<void> {
  const t = nowMs()
  for (let i = 0; i < DEFAULT_CASHFLOW_CATEGORIES.length; i++) {
    const c = DEFAULT_CASHFLOW_CATEGORIES[i]
    const id = defaultCashflowCategoryId(c.name, c.type)
    const existing = await db.query<{ id: string }>(
      `SELECT id FROM cashflow_categories WHERE id = ? OR (name = ? AND type = ? AND deleted_at IS NULL) LIMIT 1`,
      [id, c.name, c.type],
    )
    if (existing.length > 0) continue
    await db.run(
      `INSERT INTO cashflow_categories
         (id, name, type, is_system, sort_order, created_at, updated_at, dirty, sync_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)`,
      [id, c.name, c.type, c.isSystem, i, t, t],
    )
  }
}
