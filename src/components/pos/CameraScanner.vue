<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, shallowRef } from 'vue'
import { Button } from '@/components/ui/button'
import { Camera as CameraIcon, CameraOff, Flashlight, FlashlightOff, Loader2 } from 'lucide-vue-next'
import { capabilities } from '@/services/capabilities/registry'
import type { ScanResult, ScannerCapability, ScannerSession } from '@/services/capabilities/registry'
import { createScanGate } from '@/services/capabilities/scanner/scanGate'
import { getDetector } from '@/services/capabilities/scanner/detector'

const props = withDefaults(
  defineProps<{
    /** Jeda minimal sebelum kode yang sama diterima lagi (ms). */
    sameCodeMs?: number
    /** Hint di bawah bingkai. */
    hint?: string
  }>(),
  { sameCodeMs: 1500, hint: 'Arahkan barcode ke dalam kotak' },
)

const emit = defineEmits<{ scan: [result: ScanResult] }>()

const mount = ref<HTMLElement | null>(null)
const session = shallowRef<ScannerSession | null>(null)
const torchOn = ref(false)
const starting = ref(true)
const error = ref<'denied' | 'notfound' | 'unsupported' | 'other' | null>(null)
const errorDetail = ref('')
const capturing = ref(false)

const gate = createScanGate({ sameCodeMs: props.sameCodeMs })

const MESSAGES: Record<string, string> = {
  denied:
    'Izin kamera ditolak. Buka Setelan → Aplikasi → Shakala POS → Izin → Kamera, lalu coba lagi.',
  notfound: 'Kamera tidak ditemukan di perangkat ini.',
  unsupported: 'Perangkat ini tidak mendukung akses kamera dari aplikasi.',
  other: 'Kamera gagal dinyalakan.',
}

async function start() {
  error.value = null
  errorDetail.value = ''
  starting.value = true
  gate.reset()
  try {
    const scanner = capabilities.get<ScannerCapability>('scanner')
    if (!scanner || !(await scanner.isAvailable())) {
      error.value = 'unsupported'
      return
    }
    if (!mount.value) return
    session.value = await scanner.start({
      mount: mount.value,
      onScan: (r) => {
        if (gate.accept(r.value)) emit('scan', r)
      },
    })
  } catch (err) {
    const name = err instanceof Error ? err.name : ''
    errorDetail.value = err instanceof Error ? err.message : String(err)
    error.value =
      name === 'NotAllowedError' || name === 'SecurityError'
        ? 'denied'
        : name === 'NotFoundError' || name === 'OverconstrainedError'
          ? 'notfound'
          : 'other'
  } finally {
    starting.value = false
  }
}

async function stop() {
  torchOn.value = false
  const s = session.value
  session.value = null
  await s?.stop()
}

async function toggleTorch() {
  if (!session.value) return
  torchOn.value = !torchOn.value
  await session.value.setTorch(torchOn.value)
}

/** Fallback untuk WebView yang berhasil meminta izin tetapi tidak merender
 * stream getUserMedia. Kamera native mengambil satu foto lalu barcode dibaca
 * lokal; tidak membutuhkan koneksi internet. */
async function captureWithNativeCamera() {
  if (capturing.value) return
  capturing.value = true
  error.value = null
  errorDetail.value = ''
  try {
    await stop()
    const { Camera, CameraResultType, CameraSource } = await import('@capacitor/camera')
    const photo = await Camera.getPhoto({
      source: CameraSource.Camera,
      resultType: CameraResultType.DataUrl,
      quality: 92,
      width: 1600,
      correctOrientation: true,
    })
    if (!photo.dataUrl) throw new Error('Foto kamera tidak tersedia.')

    const image = new Image()
    image.src = photo.dataUrl
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new Error('Foto kamera gagal dibaca.'))
    })
    const canvas = document.createElement('canvas')
    canvas.width = image.naturalWidth || image.width
    canvas.height = image.naturalHeight || image.height
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error('Pemrosesan gambar kamera tidak tersedia.')
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    const found = await (await getDetector()).detect(canvas)
    if (!found.length) throw new Error('Barcode tidak terbaca. Arahkan lebih dekat dan ambil foto ulang.')
    if (gate.accept(found[0]!.value)) emit('scan', found[0]!)
    await start()
  } catch (err) {
    const name = err instanceof Error ? err.name : ''
    if (name !== 'UserCancellationError' && name !== 'canceled') {
      error.value = 'other'
      errorDetail.value = err instanceof Error ? err.message : String(err)
    }
  } finally {
    capturing.value = false
  }
}

/** Kamera wajib mati saat app ke background — hemat baterai & lepas sensor. */
function onVisibility() {
  if (document.visibilityState === 'hidden') void stop()
  else if (!session.value && !error.value && !capturing.value) void start()
}

onMounted(async () => {
  await start()
  document.addEventListener('visibilitychange', onVisibility)
})

onBeforeUnmount(async () => {
  document.removeEventListener('visibilitychange', onVisibility)
  await stop()
})

defineExpose({ stop, start })
</script>

<template>
  <div class="relative size-full overflow-hidden bg-black">
    <!-- <video> di-inject ke sini oleh WebScanner.start({ mount }) -->
    <div ref="mount" class="size-full" />

    <!-- Bingkai sasaran + hint -->
    <template v-if="!error && !starting">
      <div
        class="pointer-events-none absolute inset-x-8 top-1/2 h-28 -translate-y-1/2 rounded-xl border-2 border-white/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]"
      />
      <p class="pointer-events-none absolute inset-x-0 bottom-3 text-center text-xs text-white/80">
        {{ hint }}
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        class="absolute right-3 top-3 gap-1 bg-black/60 text-white hover:bg-black/80 hover:text-white"
        :disabled="capturing"
        @click="captureWithNativeCamera"
      >
        <CameraIcon class="size-4" /> Kamera foto
      </Button>
    </template>

    <div v-if="starting" class="absolute inset-0 flex items-center justify-center">
      <div class="flex flex-col items-center gap-3 text-center">
        <Loader2 class="size-8 animate-spin text-white/70" />
        <p class="px-6 text-xs text-white/70">Menyiapkan kamera...</p>
      </div>
    </div>

    <!-- Kegagalan izin/hardware: jangan tinggalin kotak hitam kosong -->
    <div
      v-if="error"
      class="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background p-6 text-center"
    >
      <CameraOff class="size-8 text-muted-foreground" />
      <p class="text-sm text-muted-foreground">{{ MESSAGES[error] }}</p>
      <p v-if="errorDetail && error === 'other'" class="max-w-sm break-words text-xs text-muted-foreground">{{ errorDetail }}</p>
      <Button variant="outline" size="sm" @click="start">Coba lagi</Button>
      <Button variant="default" size="sm" class="gap-1" :disabled="capturing" @click="captureWithNativeCamera">
        <CameraIcon class="size-4" /> Gunakan kamera perangkat
      </Button>
    </div>

    <button
      v-if="session?.torchAvailable"
      type="button"
      class="absolute right-3 top-3 flex size-10 items-center justify-center rounded-full bg-black/50 text-white backdrop-blur active:scale-95"
      :title="torchOn ? 'Matikan senter' : 'Nyalakan senter'"
      @click="toggleTorch"
    >
      <component :is="torchOn ? FlashlightOff : Flashlight" class="size-5" />
    </button>

    <slot />
  </div>
</template>
