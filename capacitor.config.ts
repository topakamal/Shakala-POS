import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.dikasirin.aja',
  appName: 'Di Kasirin',
  webDir: 'dist',
  plugins: {
    CapacitorSQLite: {
      // v1: tanpa enkripsi. PIN = kunci di level aplikasi (Phase 5).
      androidIsEncryption: false,
    },
  },
}

export default config
