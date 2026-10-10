<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useSettingsStore } from '@/stores/settings'
import { useAccountStore } from '@/stores/account'
import { useMediaStore } from '@/stores/media'
import { usePrinterStore } from '@/stores/printer'
import { encodeQrToDataUrl } from '@/lib/qris'
import { downscale, pickImage } from '@/lib/image'
import {
  newReceiptElement,
  defaultReceiptTemplate,
  RECEIPT_ELEMENT_LABELS,
  type ReceiptElement,
  type ReceiptElementType,
} from '@/lib/receiptTemplate'
import BottomSheet from '@/components/common/BottomSheet.vue'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { ArrowDown, ArrowUp, Check, Image, Plus, Redo2, Save, Trash2, Undo2 } from 'lucide-vue-next'

const settings = useSettingsStore()
const account = useAccountStore()
const media = useMediaStore()
const printer = usePrinterStore()
const { paperWidth } = storeToRefs(printer)
const { storeName, storeLogo, qrisPayload, receiptTemplate } = storeToRefs(settings)
const elements = ref<ReceiptElement[]>([])
const history = ref<ReceiptElement[][]>([])
const redoHistory = ref<ReceiptElement[][]>([])
const activeTab = ref<'templates' | 'mine'>('mine')
const addOpen = ref(false)
const editOpen = ref(false)
const selectedId = ref<string | null>(null)
const saved = ref(false)
const qrPreview = ref<string | null>(null)
const barcodePreview = ref<string | null>(null)
const imageUrl = computed(() => media.url(storeLogo.value))
const actorPreview = computed(() => account.user?.name || 'Nama kasir / owner')
const selectedIndex = computed(() => elements.value.findIndex((item) => item.id === selectedId.value))
const selected = computed(() => elements.value.find((item) => item.id === selectedId.value) ?? null)

const elementTypes: ReceiptElementType[] = ['text', 'logo', 'qrcode', 'datetime', 'separator', 'barcode', 'summary', 'store', 'actor', 'invoice', 'items']

onMounted(async () => {
  elements.value = receiptTemplate.value.map((element) => ({ ...element }))
  await printer.load()
  await media.ensure([storeLogo.value, ...elements.value.map((element) => element.imageRef)])
  await refreshCodes()
})

watch(qrisPayload, () => void refreshCodes())

async function refreshCodes() {
  qrPreview.value = qrisPayload.value ? await encodeQrToDataUrl(qrisPayload.value) : null
  const canvas = document.createElement('canvas')
  try {
    const JsBarcode = (await import('jsbarcode')).default
    JsBarcode(canvas, 'POS-20261005-001', { format: 'CODE128', displayValue: true, height: 30, margin: 2, fontSize: 10 })
    barcodePreview.value = canvas.toDataURL('image/png')
  } catch {
    barcodePreview.value = null
  }
}

function remember() {
  history.value.push(elements.value.map((element) => ({ ...element })))
  if (history.value.length > 30) history.value.shift()
  redoHistory.value = []
}

function undo() {
  const previous = history.value.pop()
  if (previous) {
    redoHistory.value.push(elements.value.map((element) => ({ ...element })))
    elements.value = previous
  }
}

function redo() {
  const next = redoHistory.value.pop()
  if (next) {
    history.value.push(elements.value.map((element) => ({ ...element })))
    elements.value = next
  }
}

function add(type: ReceiptElementType) {
  remember()
  const element = newReceiptElement(type)
  elements.value.push(element)
  selectedId.value = element.id
  addOpen.value = false
  editOpen.value = type === 'text' || type === 'logo'
}

function edit(element: ReceiptElement) {
  selectedId.value = element.id
  editOpen.value = true
}

function updateSelected(patch: Partial<ReceiptElement>) {
  if (!selected.value) return
  elements.value = elements.value.map((element) => element.id === selected.value?.id ? { ...element, ...patch } : element)
}

async function chooseElementImage() {
  const dataUrl = await pickImage()
  if (!dataUrl || !selected.value) return
  const image = await downscale(dataUrl, { maxDim: 384, mime: 'image/png' })
  const imageRef = await media.save(image)
  updateSelected({ imageRef })
}

function removeSelected() {
  if (selectedIndex.value < 0) return
  remember()
  elements.value = elements.value.filter((element) => element.id !== selectedId.value)
  selectedId.value = null
  editOpen.value = false
}

function moveSelected(delta: number) {
  const nextIndex = selectedIndex.value + delta
  if (selectedIndex.value < 0 || nextIndex < 0 || nextIndex >= elements.value.length) return
  remember()
  const copy = [...elements.value]
  ;[copy[selectedIndex.value], copy[nextIndex]] = [copy[nextIndex], copy[selectedIndex.value]]
  elements.value = copy
}

async function save() {
  await settings.setReceiptTemplate(elements.value)
  saved.value = true
  setTimeout(() => (saved.value = false), 1600)
}

function useDefaultTemplate() {
  remember()
  elements.value = defaultReceiptTemplate()
  activeTab.value = 'mine'
}

function previewLabel(element: ReceiptElement): string {
  switch (element.type) {
    case 'logo': return 'Logo toko'
    case 'store': return storeName.value
    case 'actor': return actorPreview.value
    case 'datetime': return '05 Okt 2026, 21.30'
    case 'separator': return '────────────────────'
    case 'invoice': return 'No : POS-20261005-001'
    case 'items': return 'Roti Cokelat     Rp 8.000'
    case 'summary': return 'TOTAL             Rp 8.000'
    case 'qrcode': return 'QRIS toko'
    case 'barcode': return 'POS-20261005-001'
    default: return element.text || 'Ketuk untuk mengatur teks'
  }
}
</script>

<template>
  <section class="space-y-3">
    <div class="flex items-center justify-between px-1">
      <p class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Editor Struk</p>
      <span class="text-[11px] text-muted-foreground">{{ paperWidth === 48 ? '80 mm' : '58 mm' }}</span>
    </div>
    <div class="overflow-hidden rounded-2xl border border-border bg-card">
      <div class="grid grid-cols-2 bg-muted p-1">
        <button class="rounded-xl py-2 text-sm" :class="activeTab === 'templates' ? 'bg-background shadow-sm' : 'text-muted-foreground'" @click="activeTab = 'templates'">Template</button>
        <button class="rounded-xl py-2 text-sm" :class="activeTab === 'mine' ? 'bg-background shadow-sm' : 'text-muted-foreground'" @click="activeTab = 'mine'">Template saya</button>
      </div>

      <div v-if="activeTab === 'templates'" class="space-y-3 p-4">
        <button class="w-full rounded-xl border border-primary bg-primary/5 p-3 text-left" @click="useDefaultTemplate">
          <p class="font-semibold">Struk Shakala Bakery</p>
          <p class="text-xs text-muted-foreground">Logo, detail transaksi, daftar barang, total, dan QRIS.</p>
          <span class="mt-2 inline-flex items-center gap-1 text-xs text-primary"><Check class="size-3.5" /> Template aktif</span>
        </button>
        <Button class="w-full" @click="activeTab = 'mine'">Edit template</Button>
      </div>

      <div v-else class="space-y-3 p-3">
        <div class="flex items-center gap-2">
          <Button variant="outline" size="icon" aria-label="Urungkan" :disabled="!history.length" @click="undo"><Undo2 class="size-4" /></Button>
          <Button variant="outline" size="icon" aria-label="Ulangi" :disabled="!redoHistory.length" @click="redo"><Redo2 class="size-4" /></Button>
          <Button variant="outline" class="flex-1 text-destructive" :disabled="!selected" @click="removeSelected"><Trash2 class="mr-1 size-4" /> Hapus</Button>
          <Button variant="outline" class="flex-1 text-success" @click="addOpen = true"><Plus class="mr-1 size-4" /> Tambah</Button>
        </div>

        <div class="mx-auto min-h-64 max-w-sm bg-muted p-3">
          <div class="min-h-64 space-y-1 bg-background px-3 py-4 font-mono text-[11px] text-foreground shadow-sm">
            <button
              v-for="(element, index) in elements"
              :key="element.id"
              class="relative block w-full rounded px-1 py-0.5 text-left"
              :class="selectedId === element.id ? 'outline outline-2 outline-orange-500' : 'hover:bg-muted'"
              @click="edit(element)"
            >
              <template v-if="element.type === 'logo'">
                <img v-if="element.imageRef ? media.url(element.imageRef) : imageUrl" :src="(element.imageRef ? media.url(element.imageRef) : imageUrl) ?? undefined" alt="Logo toko" class="mx-auto max-h-14 max-w-28 object-contain" />
                <span v-else class="block py-1 text-center text-muted-foreground">[Logo toko]</span>
              </template>
              <template v-else-if="element.type === 'qrcode'">
                <img v-if="qrPreview" :src="qrPreview" alt="QRIS" class="mx-auto size-14 object-contain" />
                <span v-else class="block py-2 text-center text-muted-foreground">[QRIS belum diatur]</span>
              </template>
              <template v-else-if="element.type === 'barcode'">
                <img v-if="barcodePreview" :src="barcodePreview" alt="Barcode" class="mx-auto max-h-12 max-w-full object-contain" />
                <span v-else class="block text-center">{{ previewLabel(element) }}</span>
              </template>
              <div v-else :class="[
                element.align === 'center' ? 'text-center' : element.align === 'right' ? 'text-right' : 'text-left',
                element.bold ? 'font-bold' : '', element.size === 'large' ? 'text-sm' : '',
              ]">{{ previewLabel(element) }}</div>
              <span class="absolute -right-1 -top-2 rounded bg-orange-500 px-1 text-[9px] text-white">{{ index + 1 }}</span>
            </button>
            <p v-if="!elements.length" class="py-8 text-center text-muted-foreground">Tambahkan elemen struk</p>
          </div>
        </div>

        <div v-if="selected" class="flex items-center gap-2">
          <Button variant="outline" class="flex-1" :disabled="selectedIndex <= 0" @click="moveSelected(-1)"><ArrowUp class="mr-1 size-4" /> Naik</Button>
          <Button variant="outline" class="flex-1" :disabled="selectedIndex >= elements.length - 1" @click="moveSelected(1)"><ArrowDown class="mr-1 size-4" /> Turun</Button>
          <Button variant="outline" size="icon" aria-label="Edit elemen" @click="edit(selected)"><Image class="size-4" /></Button>
        </div>
        <Button class="w-full" @click="addOpen = true">Tambah elemen</Button>
        <Button variant="outline" class="w-full" @click="save"><Save class="mr-1 size-4" /> {{ saved ? 'Tersimpan!' : 'Simpan template' }}</Button>
        <p class="text-center text-[11px] text-muted-foreground">Pengaturan template ini tersimpan di perangkat ini.</p>
      </div>
    </div>

    <BottomSheet :open="addOpen" title="Pilih elemen untuk ditambahkan" @update:open="addOpen = $event">
      <div class="grid grid-cols-2 gap-2 p-4">
        <button v-for="type in elementTypes" :key="type" class="rounded-xl border border-border p-3 text-left text-sm active:bg-muted" @click="add(type)">
          <span class="block font-medium">{{ RECEIPT_ELEMENT_LABELS[type] }}</span>
          <span class="text-xs text-muted-foreground">Tambah ke struk</span>
        </button>
      </div>
    </BottomSheet>

    <BottomSheet :open="editOpen" :title="selected ? RECEIPT_ELEMENT_LABELS[selected.type] : 'Edit elemen'" @update:open="editOpen = $event">
      <div v-if="selected" class="space-y-4 p-4">
        <div v-if="selected.type === 'text'" class="space-y-1.5">
          <Label for="element-text">Isi teks</Label>
          <textarea id="element-text" :value="selected.text" rows="3" maxlength="180" class="w-full rounded-xl border border-input bg-background p-3 text-sm" placeholder="Masukkan teks" @input="updateSelected({ text: ($event.target as HTMLTextAreaElement).value })" />
        </div>
        <div v-else-if="selected.type === 'logo'" class="space-y-2">
          <p class="text-sm">Pilih gambar untuk elemen ini, atau gunakan logo Profil Toko.</p>
          <img v-if="selected.imageRef ? media.url(selected.imageRef) : imageUrl" :src="(selected.imageRef ? media.url(selected.imageRef) : imageUrl) ?? undefined" alt="Gambar struk" class="mx-auto max-h-32 max-w-48 object-contain" />
          <p v-else class="text-xs text-amber-600">Belum ada gambar. Tambahkan gambar atau logo pada Profil Toko.</p>
          <Button variant="outline" class="w-full" @click="chooseElementImage">Pilih gambar</Button>
        </div>
        <div v-else-if="selected.type === 'qrcode'" class="space-y-2 text-sm">
          <p>Kode QR memakai QRIS toko dari pengaturan pembayaran.</p>
          <p v-if="!qrisPayload" class="text-xs text-amber-600">QRIS belum diunggah di pengaturan pembayaran.</p>
          <img v-if="qrPreview" :src="qrPreview" alt="QRIS" class="mx-auto size-36" />
        </div>
        <div v-else-if="selected.type === 'barcode'" class="space-y-2 text-sm">
          <p>Barcode berisi nomor invoice transaksi.</p>
          <img v-if="barcodePreview" :src="barcodePreview" alt="Barcode contoh" class="mx-auto max-w-full" />
        </div>
        <div class="space-y-1.5">
          <Label for="element-align">Perataan</Label>
          <select id="element-align" :value="selected.align" class="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" @change="updateSelected({ align: ($event.target as HTMLSelectElement).value as ReceiptElement['align'] })">
            <option value="left">Kiri</option><option value="center">Tengah</option><option value="right">Kanan</option>
          </select>
        </div>
        <div class="space-y-1.5">
          <Label for="element-size">Ukuran teks</Label>
          <select id="element-size" :value="selected.size" class="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" @change="updateSelected({ size: ($event.target as HTMLSelectElement).value as ReceiptElement['size'] })">
            <option value="normal">Normal</option><option value="large">Besar</option>
          </select>
        </div>
        <Button variant="outline" class="w-full text-destructive" @click="removeSelected"><Trash2 class="mr-1 size-4" /> Hapus elemen</Button>
      </div>
    </BottomSheet>
  </section>
</template>
