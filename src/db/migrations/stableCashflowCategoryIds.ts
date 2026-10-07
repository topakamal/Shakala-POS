import type { Db } from '@/db/types'
import { DEFAULT_CASHFLOW_CATEGORIES, defaultCashflowCategoryId } from '@/db/seedCashflow'

export const stableCashflowCategoryIds = {
  version: 8,
  name: 'stable-cashflow-category-ids',
  up: async (db: Db) => {
    for (const category of DEFAULT_CASHFLOW_CATEGORIES) {
      const stableId = defaultCashflowCategoryId(category.name, category.type)
      const rows = await db.query<{ id: string }>(
        `SELECT id FROM cashflow_categories
         WHERE name = ? AND type = ? AND is_system = ? AND deleted_at IS NULL
         ORDER BY created_at ASC LIMIT 1`,
        [category.name, category.type, category.isSystem],
      )
      const oldId = rows[0]?.id
      if (!oldId || oldId === stableId) continue
      const stableExists = await db.query<{ id: string }>(
        'SELECT id FROM cashflow_categories WHERE id = ? LIMIT 1', [stableId],
      )
      if (stableExists.length) {
        await db.run('UPDATE cashflow_entries SET category_id = ? WHERE category_id = ?', [stableId, oldId])
        await db.run('DELETE FROM cashflow_categories WHERE id = ?', [oldId])
      } else {
        await db.run('UPDATE cashflow_entries SET category_id = ? WHERE category_id = ?', [stableId, oldId])
        await db.run('UPDATE cashflow_categories SET id = ? WHERE id = ?', [stableId, oldId])
      }
    }
  },
}
