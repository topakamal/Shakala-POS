export type ReceiptElementType =
  | 'logo'
  | 'store'
  | 'actor'
  | 'text'
  | 'datetime'
  | 'separator'
  | 'invoice'
  | 'items'
  | 'summary'
  | 'qrcode'
  | 'barcode'

export interface ReceiptElement {
  id: string
  type: ReceiptElementType
  text: string
  align: 'left' | 'center' | 'right'
  bold: boolean
  size: 'normal' | 'large'
  imageRef?: string
}

export const RECEIPT_ELEMENT_LABELS: Record<ReceiptElementType, string> = {
  logo: 'Gambar / Logo',
  store: 'Nama dan info toko',
  actor: 'Nama kasir / owner',
  text: 'Teks',
  datetime: 'Tanggal & waktu',
  separator: 'Pemisah',
  invoice: 'Nomor invoice',
  items: 'Daftar barang',
  summary: 'Ringkasan pembayaran',
  qrcode: 'Kode QRIS',
  barcode: 'Kode batang invoice',
}

export function newReceiptElement(type: ReceiptElementType): ReceiptElement {
  const names: Record<ReceiptElementType, string> = {
    logo: '', store: '', actor: '', text: 'Teks toko', datetime: '', separator: '',
    invoice: '', items: '', summary: '', qrcode: '', barcode: '',
  }
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    type,
    text: names[type],
    align: type === 'logo' || type === 'store' || type === 'qrcode' || type === 'barcode' ? 'center' : 'left',
    bold: type === 'store' || type === 'summary',
    size: type === 'store' || type === 'summary' ? 'large' : 'normal',
  }
}

export function defaultReceiptTemplate(): ReceiptElement[] {
  return (['logo', 'store', 'actor', 'text', 'separator', 'invoice', 'datetime', 'separator', 'items', 'separator', 'summary', 'qrcode', 'text'] as ReceiptElementType[])
    .map((type) => newReceiptElement(type))
    .map((element, index) => index === 3
      ? { ...element, text: '', align: 'center' as const }
      : index === 12
        ? { ...element, text: 'Terima kasih 🙏', align: 'center' as const }
        : element)
}

export function parseReceiptTemplate(value: string | undefined): ReceiptElement[] {
  if (!value) return defaultReceiptTemplate()
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed) || !parsed.length) return defaultReceiptTemplate()
    const allowed = new Set<ReceiptElementType>(Object.keys(RECEIPT_ELEMENT_LABELS) as ReceiptElementType[])
    return parsed.filter((row): row is ReceiptElement =>
      !!row && typeof row === 'object' && typeof row.id === 'string' && allowed.has(row.type)
      && ['left', 'center', 'right'].includes(row.align)
      && ['normal', 'large'].includes(row.size)
      && typeof row.text === 'string' && typeof row.bold === 'boolean')
  } catch {
    return defaultReceiptTemplate()
  }
}
