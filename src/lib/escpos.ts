import type { ReceiptJob } from '@/services/capabilities/registry'

/**
 * Encoder ESC/POS: ubah `ReceiptJob` (baris + align/bold/size) jadi byte mentah
 * yang dikirim ke printer thermal. Murni (tanpa I/O) → gampang diuji & dipakai
 * transport apa pun (Bluetooth/USB) tanpa tahu detail hardware.
 *
 * Referensi perintah: ESC @ (init), ESC a n (align), ESC E n (bold),
 * GS ! n (ukuran), LF (0x0A), GS V m (potong kertas).
 */
export interface EscposOpts {
  /** Baris kosong sebelum potong (biar teks lolos dari head). Default 3. */
  feed?: number
  /** Kirim perintah potong kertas di akhir. Default true (aman walau tanpa cutter). */
  cut?: boolean
}

async function appendRasterLogo(
  push: (...bytes: number[]) => void,
  dataUrl: string,
  maxWidth: number,
): Promise<void> {
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const value = new Image()
    value.onload = () => resolve(value)
    value.onerror = () => reject(new Error('Logo struk tidak dapat dibaca'))
    value.src = dataUrl
  })
  // Remove white/transparent margins from uploaded logo files. This keeps the
  // logo close to the receipt number even when the source image is a photo or
  // has a large white canvas around the artwork.
  const source = document.createElement('canvas')
  source.width = image.naturalWidth
  source.height = image.naturalHeight
  const sourceContext = source.getContext('2d')
  if (!sourceContext) throw new Error('Canvas logo struk tidak tersedia')
  sourceContext.fillStyle = '#fff'
  sourceContext.fillRect(0, 0, source.width, source.height)
  sourceContext.drawImage(image, 0, 0)
  const sourcePixels = sourceContext.getImageData(0, 0, source.width, source.height)
  let minX = source.width
  let minY = source.height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < source.height; y++) {
    for (let x = 0; x < source.width; x++) {
      const offset = (y * source.width + x) * 4
      const luminance = sourcePixels.data[offset] * 0.299 + sourcePixels.data[offset + 1] * 0.587 + sourcePixels.data[offset + 2] * 0.114
      if (sourcePixels.data[offset + 3] > 30 && luminance < 220) {
        minX = Math.min(minX, x)
        minY = Math.min(minY, y)
        maxX = Math.max(maxX, x)
        maxY = Math.max(maxY, y)
      }
    }
  }
  const margin = 4
  const cropX = maxX >= 0 ? Math.max(0, minX - margin) : 0
  const cropY = maxY >= 0 ? Math.max(0, minY - margin) : 0
  const cropRight = maxX >= 0 ? Math.min(source.width - 1, maxX + margin) : source.width - 1
  const cropBottom = maxY >= 0 ? Math.min(source.height - 1, maxY + margin) : source.height - 1
  const cropWidth = Math.max(1, cropRight - cropX + 1)
  const cropHeight = Math.max(1, cropBottom - cropY + 1)
  const scale = Math.min(1, maxWidth / cropWidth, 140 / cropHeight)
  const width = Math.max(1, Math.floor(cropWidth * scale))
  const height = Math.max(1, Math.floor(cropHeight * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Canvas logo struk tidak tersedia')
  context.fillStyle = '#fff'
  context.fillRect(0, 0, width, height)
  context.drawImage(source, cropX, cropY, cropWidth, cropHeight, 0, 0, width, height)
  const pixels = context.getImageData(0, 0, width, height).data
  const rowBytes = Math.ceil(width / 8)

  push(0x1b, 0x61, 0x01)
  push(0x1d, 0x76, 0x30, 0x00, rowBytes & 0xff, (rowBytes >> 8) & 0xff, height & 0xff, (height >> 8) & 0xff)
  for (let y = 0; y < height; y++) {
    for (let xByte = 0; xByte < rowBytes; xByte++) {
      let value = 0
      for (let bit = 0; bit < 8; bit++) {
        const x = xByte * 8 + bit
        if (x >= width) continue
        const offset = (y * width + x) * 4
        const luminance = pixels[offset] * 0.299 + pixels[offset + 1] * 0.587 + pixels[offset + 2] * 0.114
        if (pixels[offset + 3] > 30 && luminance < 180) value |= 0x80 >> bit
      }
      push(value)
    }
  }
  push(0x0a)
}

export async function encodeReceipt(job: ReceiptJob, opts: EscposOpts = {}): Promise<Uint8Array> {
  const bytes: number[] = []
  const push = (...b: number[]) => {
    for (const x of b) bytes.push(x)
  }
  // Teks: printer thermal pakai charset 1-byte. Codepoint > 0xFF (emoji, dsb)
  // tak bisa dicetak → ganti '?'. ASCII & Latin-1 diteruskan apa adanya.
  const text = (s: string) => {
    for (const ch of s) {
      if (ch === '\u00a0') {
        push(0x20)
        continue
      }
      const c = ch.codePointAt(0) ?? 0x3f
      push(c > 0xff ? 0x3f : c)
    }
  }

  push(0x1b, 0x40) // ESC @ — inisialisasi

  if (job.logoDataUrl) {
    try {
      await appendRasterLogo(push, job.logoDataUrl, job.paperWidth && job.paperWidth > 32 ? 576 : 384)
    } catch {
      // Cetak teks tetap dilanjutkan bila format logo tidak didukung.
    }
  }

  // Lacak state agar tak kirim perintah berulang tiap baris.
  let curAlign = -1
  let curBold = -1
  let curSize = -1
  for (const line of job.lines) {
    const align = line.align === 'center' ? 1 : line.align === 'right' ? 2 : 0
    if (align !== curAlign) {
      push(0x1b, 0x61, align) // ESC a n
      curAlign = align
    }
    const bold = line.bold ? 1 : 0
    if (bold !== curBold) {
      push(0x1b, 0x45, bold) // ESC E n
      curBold = bold
    }
    // GS ! n — bit tinggi = tinggi ganda, bit rendah = lebar ganda. large = 0x11.
    const size = line.size === 'large' ? 0x11 : 0x00
    if (size !== curSize) {
      push(0x1d, 0x21, size) // GS ! n
      curSize = size
    }
    text(line.text ?? '')
    push(0x0a) // LF
  }

  // Reset gaya ke normal.
  push(0x1b, 0x61, 0x00) // align kiri
  push(0x1b, 0x45, 0x00) // bold off
  push(0x1d, 0x21, 0x00) // ukuran normal

  const feed = opts.feed ?? 1
  for (let i = 0; i < feed; i++) push(0x0a)
  if (opts.cut ?? true) push(0x1d, 0x56, 0x01) // GS V 1 — potong sebagian

  return Uint8Array.from(bytes)
}
