import type { Sale, SaleItem } from '@/db/types'
import type { ReceiptJob, ReceiptLine } from '@/services/capabilities/registry'
import { formatRupiah } from './money'
import { formatDateTime } from './datetime'
import type { ReceiptHeaderMode } from '@/stores/settings'
import type { ReceiptElement } from '@/lib/receiptTemplate'

export interface ReceiptOpts {
  storeName: string
  storeOwner?: string
  headerMode?: ReceiptHeaderMode
  logoDataUrl?: string | null
  headerText?: string
  footerText?: string
  template?: readonly ReceiptElement[]
  qrisDataUrl?: string | null
  imageDataByRef?: Record<string, string | null>
  width?: number // karakter per baris (monospace); default 32 ala thermal 58mm
}

type ReceiptErrorDetail =
  | { readonly kind: 'open-sale'; readonly number: string }
  | { readonly kind: 'missing-sold-at'; readonly number: string }

export class ReceiptError extends Error {
  readonly name = 'ReceiptError'

  constructor(readonly detail: ReceiptErrorDetail) {
    super(receiptErrorMessage(detail))
  }
}

const PAY_LABEL: Record<string, string> = {
  cash: 'Tunai',
  qris: 'QRIS',
  transfer: 'Transfer',
}

function receiptErrorMessage(detail: ReceiptErrorDetail): string {
  switch (detail.kind) {
    case 'open-sale':
      return `Open Bill ${detail.number} belum dapat dicetak`
    case 'missing-sold-at':
      return `Waktu pembayaran untuk transaksi ${detail.number} tidak tersedia`
  }
}

function completedSaleTime(sale: Sale): number {
  if (sale.status === 'open') {
    throw new ReceiptError({ kind: 'open-sale', number: sale.number })
  }
  const soldAt = sale.sold_at
  if (soldAt === null) {
    throw new ReceiptError({ kind: 'missing-sold-at', number: sale.number })
  }
  return soldAt
}

/** Baris dua kolom rata kiri-kanan (monospace). */
function row(left: string, right: string, width: number): string {
  const l = left.length + right.length > width ? left.slice(0, width - right.length - 1) : left
  const gap = Math.max(1, width - l.length - right.length)
  return l + ' '.repeat(gap) + right
}

/** Bangun ReceiptJob dari sale + items → dipakai printer capability apa pun. */
export function buildReceipt(
  sale: Sale,
  items: SaleItem[],
  opts: ReceiptOpts,
): ReceiptJob {
  const soldAt = completedSaleTime(sale)
  const w = opts.width ?? 32
  const div = '-'.repeat(w)
  const lines: ReceiptLine[] = []

  if (opts.template?.length) {
    for (const element of opts.template) {
      switch (element.type) {
        case 'logo':
          {
            const image = element.imageRef ? opts.imageDataByRef?.[element.imageRef] : opts.logoDataUrl
            if (image) lines.push({ text: '', imageDataUrl: image, align: element.align })
          }
          break
        case 'store':
          lines.push({ text: opts.storeName, align: element.align, bold: element.bold, size: element.size })
          if (opts.storeOwner) lines.push({ text: opts.storeOwner, align: element.align })
          break
        case 'text':
          if (element.text.trim()) lines.push({ text: element.text, align: element.align, bold: element.bold, size: element.size })
          break
        case 'datetime':
          lines.push({ text: `Tgl : ${formatDateTime(soldAt)}`, align: element.align, bold: element.bold, size: element.size })
          break
        case 'separator':
          lines.push({ text: '-'.repeat(w) })
          break
        case 'invoice':
          lines.push({ text: `No  : ${sale.number}`, align: element.align, bold: element.bold, size: element.size })
          break
        case 'items':
          for (const it of items) {
            lines.push({ text: it.name_snapshot, align: 'left' })
            lines.push({ text: row(`  ${it.qty} x ${formatRupiah(it.price_snapshot)}`, formatRupiah(it.line_total), w) })
          }
          break
        case 'summary':
          lines.push({ text: row('Subtotal', formatRupiah(sale.subtotal), w) })
          if (sale.discount > 0) lines.push({ text: row('Diskon', `-${formatRupiah(sale.discount)}`, w) })
          if (sale.tax > 0) lines.push({ text: row('Pajak', formatRupiah(sale.tax), w) })
          lines.push({ text: row('TOTAL', formatRupiah(sale.total), w), bold: true, size: element.size })
          lines.push({ text: row(PAY_LABEL[sale.payment_method] ?? 'Bayar', formatRupiah(sale.paid), w) })
          if (sale.change_due > 0) lines.push({ text: row('Kembali', formatRupiah(sale.change_due), w) })
          break
        case 'qrcode':
          if (opts.qrisDataUrl) lines.push({ text: '', imageDataUrl: opts.qrisDataUrl, align: element.align })
          break
        case 'barcode':
          lines.push({ text: '', barcodeValue: sale.number, align: element.align })
          break
      }
    }
    return {
      title: `Struk ${sale.number}`,
      lines,
      paperWidth: w,
    }
  }

  const mode = opts.headerMode ?? 'name'
  const hasLogo = !!opts.logoDataUrl
  if (mode !== 'logo' || !hasLogo) {
    lines.push({ text: opts.storeName, align: 'center', bold: true, size: 'large' })
    if (opts.storeOwner) lines.push({ text: opts.storeOwner, align: 'center' })
  }
  if (opts.headerText?.trim()) {
    for (const line of opts.headerText.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
      lines.push({ text: line, align: 'center' })
    }
  }
  // Saat memakai logo, langsung lanjut ke nomor invoice agar tidak ada jarak
  // divider tambahan di antara logo dan identitas transaksi.
  if (mode !== 'logo' || !hasLogo || opts.headerText?.trim()) lines.push({ text: div })
  lines.push({ text: `No  : ${sale.number}` })
  lines.push({ text: `Tgl : ${formatDateTime(soldAt)}` })
  lines.push({ text: div })

  for (const it of items) {
    lines.push({ text: it.name_snapshot })
    lines.push({
      text: row(`  ${it.qty} x ${formatRupiah(it.price_snapshot)}`, formatRupiah(it.line_total), w),
    })
  }

  lines.push({ text: div })
  lines.push({ text: row('Subtotal', formatRupiah(sale.subtotal), w) })
  if (sale.discount > 0) {
    lines.push({ text: row('Diskon', `-${formatRupiah(sale.discount)}`, w) })
  }
  if (sale.tax > 0) lines.push({ text: row('Pajak', formatRupiah(sale.tax), w) })
  lines.push({ text: row('TOTAL', formatRupiah(sale.total), w), bold: true })
  lines.push({ text: row(PAY_LABEL[sale.payment_method] ?? 'Bayar', formatRupiah(sale.paid), w) })
  if (sale.change_due > 0) {
    lines.push({ text: row('Kembali', formatRupiah(sale.change_due), w) })
  }
  lines.push({ text: div })
  const footer = opts.footerText?.trim() || 'Terima kasih 🙏'
  for (const line of footer.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
    lines.push({ text: line, align: 'center' })
  }

  return {
    title: `Struk ${sale.number}`,
    lines,
    logoDataUrl: mode === 'name' ? undefined : (opts.logoDataUrl ?? undefined),
    paperWidth: w,
  }
}
