import type {
  PrinterCapability,
  ReceiptJob,
} from '@/services/capabilities/registry'

/**
 * Printer default v1: render struk sebagai HTML lalu buka dialog print browser.
 * Bukan hardware — tapi bikin seluruh alur "cetak struk" jalan tanpa plugin.
 * Nanti tinggal daftar ThermalPrinter buat hardware asli, ini jadi fallback.
 */
export class WebPreviewPrinter implements PrinterCapability {
  readonly id = 'printer' as const

  async isAvailable(): Promise<boolean> {
    return typeof window !== 'undefined'
  }

  async print(job: ReceiptJob): Promise<void> {
    const html = job.html ?? await this.renderHtml(job)
    const wide = (job.paperWidth ?? 32) > 32
    const w = window.open('', '_blank', `width=${wide ? 480 : 380},height=640`)
    if (!w) return
    w.document.write(html)
    w.document.close()
    w.focus()
    setTimeout(() => {
      w.print()
    }, 250)
  }

  private async renderHtml(job: ReceiptJob): Promise<string> {
    // Lebar preview mengikuti setting kertas: 58mm ≈ 32 kolom, 80mm ≈ 48 kolom.
    const wide = (job.paperWidth ?? 32) > 32
    const pageWidth = wide ? 400 : 280
    const imgMax = wide ? 280 : 190
    const imgMaxH = wide ? 180 : 120
    const logoMaxW = wide ? 280 : 190
    const logoMaxH = wide ? 90 : 62
    const logo = job.logoDataUrl
      ? `<img src="${job.logoDataUrl}" alt="Logo toko" style="display:block;max-width:${logoMaxW}px;max-height:${logoMaxH}px;margin:0 auto 2px;object-fit:contain;background:#fff" />`
      : ''
    const renderedLines: string[] = []
    for (const line of job.lines) {
      if (line.imageDataUrl) {
        const scaleFactor = (line.imageScale ?? 100) / 100
        renderedLines.push(`<img src="${line.imageDataUrl}" alt="Elemen struk" style="display:block;max-width:${Math.round(imgMax * scaleFactor)}px;max-height:${Math.round(imgMaxH * scaleFactor)}px;margin:2px auto;object-fit:contain;background:#fff" />`)
        continue
      }
      if (line.barcodeValue) {
        const canvas = document.createElement('canvas')
        try {
          const JsBarcode = (await import('jsbarcode')).default
          JsBarcode(canvas, line.barcodeValue, { format: 'CODE128', displayValue: true, height: 42, margin: 2, fontSize: 11 })
          renderedLines.push(`<img src="${canvas.toDataURL('image/png')}" alt="Barcode" style="display:block;max-width:100%;margin:4px auto" />`)
        } catch {
          renderedLines.push(`<div>${line.barcodeValue}</div>`)
        }
        continue
      }
      {
        const l = line
        const align = l.align ?? 'left'
        const weight = l.bold ? '700' : '400'
        const size = l.size === 'large' ? '16px' : '12px'
        renderedLines.push(`<div style="text-align:${align};font-weight:${weight};font-size:${size}">${escapeHtml(l.text || '') || '&nbsp;'}</div>`)
      }
    }
    const body = renderedLines.join('')
    return `<!doctype html><html><head><meta charset="utf-8"><title>${job.title}</title>
      <style>
        body{font-family:'Courier New',monospace;width:${pageWidth}px;margin:0 auto;padding:4px;color:#000}
        .divider{border-top:1px dashed #000;margin:2px 0}
      </style></head><body>${logo}${body}</body></html>`
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character] ?? character)
}
