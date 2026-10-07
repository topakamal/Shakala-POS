<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { Capacitor } from '@capacitor/core'
import BottomNav from '@/components/layout/BottomNav.vue'
import SideNav from '@/components/layout/SideNav.vue'
import SplashScreen from '@/components/layout/SplashScreen.vue'
import { useSettingsStore } from '@/stores/settings'
import { useHardwareBack } from '@/composables/useHardwareBack'

const route = useRoute()
const nativeScannerShell = computed(
  () => Capacitor.isNativePlatform() && route.name === 'pos-scan',
)
// Bottom nav (HP): hanya di halaman utama. Sidebar (tablet): selalu, kecuali layar kunci.
const showNav = computed(() => !route.meta.hideNav)
const showSideNav = computed(() => route.name !== 'lock')

// Tombol back hardware Android: mundur/keluar dengan benar (bukan langsung nutup app).
const { showExitHint } = useHardwareBack()

// Splash in-app: tampil sebentar saat boot bila diaktifkan (default OFF).
const settings = useSettingsStore()
const showSplash = ref(settings.splashEnabled)
onMounted(() => {
  if (showSplash.value) setTimeout(() => (showSplash.value = false), 1500)
})

watch(
  nativeScannerShell,
  (active) => document.body.classList.toggle('native-scanner-shell', active),
  { immediate: true },
)

onBeforeUnmount(() => document.body.classList.remove('native-scanner-shell'))
</script>

<template>
  <!-- Shell responsif: sidebar kiri di tablet/desktop (≥md), bottom-nav di HP -->
  <div
    :class="[
      'flex h-full w-full overflow-hidden sm:h-screen',
      nativeScannerShell ? 'bg-transparent' : 'bg-background',
    ]"
  >
    <SideNav v-if="showSideNav" />
    <div class="flex min-w-0 flex-1 flex-col overflow-hidden">
      <main class="no-scrollbar flex-1 overflow-y-auto">
        <RouterView v-slot="{ Component }">
          <component :is="Component" />
        </RouterView>
      </main>
      <BottomNav v-if="showNav" />
    </div>
  </div>

  <Transition name="splash">
    <SplashScreen v-if="showSplash" />
  </Transition>

  <!-- Hint "tekan sekali lagi untuk keluar" (back di Home) -->
  <Transition name="hint">
    <div
      v-if="showExitHint"
      class="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center px-4"
    >
      <div class="rounded-full bg-foreground/90 px-4 py-2 text-xs font-medium text-background shadow-lg">
        Tekan sekali lagi untuk keluar
      </div>
    </div>
  </Transition>
</template>

<style>
.splash-leave-active {
  transition: opacity 0.4s ease;
}
.splash-leave-to {
  opacity: 0;
}
.hint-enter-active,
.hint-leave-active {
  transition: opacity 0.25s ease;
}
.hint-enter-from,
.hint-leave-to {
  opacity: 0;
}
</style>

<style>
body.native-scanner-shell {
  background-color: transparent;
}
</style>
