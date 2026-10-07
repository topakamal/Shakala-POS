import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import type {
  ScannerCapability,
  ScannerSession,
  ScannerStartOptions,
} from '../registry'

interface NativeScannerPlugin {
  start(options: { left: number; top: number; width: number; height: number }): Promise<{
    torchAvailable: boolean
  }>
  stop(): Promise<void>
  setTorch(options: { enabled: boolean }): Promise<void>
  addListener(
    eventName: 'barcodeScanned',
    listener: (result: { value: string; format: string }) => void,
  ): Promise<PluginListenerHandle>
}

const NativeScannerPlugin = registerPlugin<NativeScannerPlugin>('NativeBarcodeScanner')

export class NativeScanner implements ScannerCapability {
  readonly id = 'scanner' as const
  readonly rendersBehindWebview = true

  async isAvailable(): Promise<boolean> {
    return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('NativeBarcodeScanner')
  }

  async start(opts: ScannerStartOptions): Promise<ScannerSession> {
    const rect = opts.mount.getBoundingClientRect()
    const scale = window.devicePixelRatio || 1
    let listener: PluginListenerHandle | null = null

    try {
      listener = await NativeScannerPlugin.addListener('barcodeScanned', (result) => {
        opts.onScan({ value: result.value, format: result.format })
      })
      const result = await NativeScannerPlugin.start({
        left: Math.round(rect.left * scale),
        top: Math.round(rect.top * scale),
        width: Math.round(rect.width * scale),
        height: Math.round(rect.height * scale),
      })

      let stopped = false
      return {
        torchAvailable: result.torchAvailable,
        async setTorch(on: boolean) {
          if (!stopped) await NativeScannerPlugin.setTorch({ enabled: on })
        },
        async stop() {
          if (stopped) return
          stopped = true
          await listener?.remove()
          listener = null
          await NativeScannerPlugin.stop()
        },
      }
    } catch (error) {
      await listener?.remove()
      listener = null
      throw error
    }
  }
}
