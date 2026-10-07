import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { Capacitor } from '@capacitor/core'
import { getDb } from '@/db/sqlite'
import { resetLocalBusinessData } from '@/db/reset'
import { SettingsRepository } from '@/repositories/settings.repo'
import { OutboxRepository } from '@/repositories/outbox.repo'
import { useSettingsStore } from '@/stores/settings'
import { useMediaStore } from '@/stores/media'
import {
  ApiClient,
  ApiError,
  type ApiContext,
  type AccountUser,
  type AccountStore,
  type AuthPayload,
  type PublicStore,
  type StaffMember,
  type StaffPermission,
} from '@/services/api/client'
import { ENV_API_BASE_URL } from '@/services/api/config'
import { signInWithGoogle, signOutGoogle } from '@/services/auth/google'
import {
  clearAccountCredential,
  loadAccountCredential,
  persistAccountCredential,
  type AccountCredentialStorage,
  LegacyCredentialRemovalError,
  SecureCredentialUnavailableError,
} from '@/services/auth/accountCredentials'
import { androidSecureCredentialStore } from '@/services/auth/androidSecureCredentials'
import { SYNC_ENTITIES } from '@/services/sync/applyPull'
import { SyncEngine } from '@/services/sync/SyncEngine'
import { FirebaseApiClient } from '@/services/firebase/api'
import type { ChangeEnvelope, PullResult, PushResult } from '@/services/sync/types'

interface PosCloudApi {
  loginEmail(email: string, password: string): Promise<AuthPayload>
  registerEmail(name: string, email: string, password: string, role: 'owner' | 'staff'): Promise<AuthPayload>
  loginGoogle(idToken: string): Promise<AuthPayload>
  logout(): Promise<void>
  createStore(name: string): Promise<{ store: AccountStore; stores: AccountStore[] }>
  renameStore(id: string | number, name: string): Promise<{ store: AccountStore }>
  changePassword(currentPassword: string, nextPassword: string): Promise<void>
  deleteStore(id: string | number): Promise<{ stores: AccountStore[]; currentStoreId: string | null }>
  resetStore(storeId: string, password: string): Promise<void>
  availableStores(): Promise<{ stores: PublicStore[] }>
  joinStore(storeId: string): Promise<AuthPayload>
  staff(storeId: string): Promise<{ staff: StaffMember[] }>
  updateStaff(storeId: string, uid: string, patch: { role?: 'staff' | 'manager'; permissions?: StaffPermission[] }): Promise<StaffMember>
  dismissStaff(storeId: string, uid: string): Promise<void>
  syncPush(changes: ChangeEnvelope[]): Promise<PushResult>
  syncPull(entity: string, since: number): Promise<PullResult>
}

/** Semua device-local (disimpan di tabel settings, tidak ikut sync). */
const KEYS = {
  baseUrl: 'account_base_url',
  token: 'account_token',
  user: 'account_user',
  stores: 'account_stores',
  storeId: 'account_store_id',
} as const

const UNRESOLVED_OUTBOX_ERROR =
  'Perubahan belum aman disinkronkan. Selesaikan sinkronisasi atau gunakan Coba lagi untuk perubahan gagal sebelum pindah outlet.'

/**
 * Akun cloud POS Pro: sumber tunggal token bearer + toko aktif. Beda dengan
 * `stores/auth.ts` (kunci PIN lokal). Di Android, token disimpan melalui
 * Android Keystore; browser mempertahankan penyimpanan settings yang ada.
 */
export const useAccountStore = defineStore('account', () => {
  const settings = useSettingsStore()

  const baseUrl = ref(ENV_API_BASE_URL)
  const token = ref<string | null>(null)
  const user = ref<AccountUser | null>(null)
  const stores = ref<AccountStore[]>([])
  const availableStoreOptions = ref<PublicStore[]>([])
  const staffMembers = ref<StaffMember[]>([])
  const currentStoreId = ref<string | null>(null)
  const status = ref<'idle' | 'loading'>('idle')
  const error = ref<string | null>(null)

  const isAuthenticated = computed(() => !!token.value)
  const currentStore = computed(
    () => stores.value.find((s) => String(s.id) === currentStoreId.value) ?? null,
  )
  function hasPermission(permission: StaffPermission): boolean {
    return user.value?.account_role === 'owner' || user.value?.permissions?.includes(permission) === true
  }

  function repo() {
    return new SettingsRepository(getDb())
  }

  function credentialStorage(): AccountCredentialStorage {
    const legacy = {
      read: () => repo().get(KEYS.token),
      write: (value: string) => repo().set(KEYS.token, value),
      remove: () => repo().set(KEYS.token, ''),
    }

    if (Capacitor.getPlatform() === 'android') {
      return { kind: 'android', legacy, secure: androidSecureCredentialStore }
    }
    return { kind: 'browser', legacy }
  }

  // Header dinamis untuk ApiClient (di-resolve tiap request).
  const context: ApiContext = {
    baseUrl: () => baseUrl.value,
    token: () => token.value,
    deviceId: () => settings.deviceId,
    storeId: () => currentStoreId.value,
    onUnauthorized: () => void clearSessionAfterUnauthorized(),
  }
  const firebaseApi = new FirebaseApiClient()
  const useFirebase = (import.meta.env.VITE_BACKEND as string | undefined) !== 'laravel'
  const api: PosCloudApi = useFirebase
    ? {
        loginEmail: (email, password) => firebaseApi.loginEmail(email, password),
        registerEmail: (name, email, password, role) => firebaseApi.registerEmail(name, email, password, role),
        loginGoogle: async () => {
          throw new Error('Login Google Firebase belum diaktifkan. Gunakan email dan password.')
        },
        logout: () => firebaseApi.logout(),
        createStore: (name) => firebaseApi.createStore(name),
        renameStore: (id, name) => firebaseApi.renameStore(id, name),
        changePassword: (current, next) => firebaseApi.changePassword(current, next),
        deleteStore: (id) => firebaseApi.deleteStore(id),
        resetStore: (storeId, password) => firebaseApi.resetStore(storeId, password),
        availableStores: () => firebaseApi.availableStores(),
        joinStore: (storeId) => firebaseApi.joinStore(storeId),
        staff: (storeId) => firebaseApi.staff(storeId),
        updateStaff: (storeId, uid, patch) => firebaseApi.updateStaff(storeId, uid, patch),
        dismissStaff: (storeId, uid) => firebaseApi.dismissStaff(storeId, uid),
        syncPush: (changes) => {
          if (!currentStoreId.value) throw new Error('Toko Firebase belum dipilih.')
          return firebaseApi.syncPush(changes, currentStoreId.value)
        },
        syncPull: (entity, since) => {
          if (!currentStoreId.value) throw new Error('Toko Firebase belum dipilih.')
          return firebaseApi.syncPull(entity, since, currentStoreId.value)
        },
      }
    : new ApiClient(context)

  async function load(): Promise<void> {
    const all = await repo().getAll()
    baseUrl.value = all[KEYS.baseUrl] || ENV_API_BASE_URL

    const credential = await loadAccountCredential(credentialStorage())
    if (credential.kind === 'secure-unavailable') {
      token.value = null
      user.value = null
      stores.value = []
      currentStoreId.value = null
      error.value = 'Penyimpanan kredensial aman Android tidak tersedia. Silakan masuk kembali.'
      return
    }
    if (credential.kind === 'migration-incomplete') {
      token.value = null
      user.value = null
      stores.value = []
      currentStoreId.value = null
      error.value =
        'Token lama belum dapat dihapus. Coba lagi untuk menyelesaikan migrasi keamanan sebelum masuk kembali.'
      return
    }

    token.value = credential.kind === 'loaded' ? credential.value : null
    user.value = token.value && all[KEYS.user] ? (JSON.parse(all[KEYS.user]) as AccountUser) : null
    stores.value = token.value && all[KEYS.stores] ? (JSON.parse(all[KEYS.stores]) as AccountStore[]) : []
    currentStoreId.value = token.value ? all[KEYS.storeId] || null : null
  }

  async function setBaseUrl(url: string): Promise<void> {
    baseUrl.value = url.trim().replace(/\/+$/, '')
    await repo().set(KEYS.baseUrl, baseUrl.value)
  }

  async function applyAuth(p: AuthPayload): Promise<void> {
    const nextStoreId =
      (p.user.current_store_id != null ? String(p.user.current_store_id) : null) ??
      (p.stores[0] ? String(p.stores[0].id) : null)
    await persistAccountCredential(credentialStorage(), p.token)
    token.value = p.token
    user.value = p.user
    stores.value = p.stores
    currentStoreId.value = nextStoreId
    await repo().setMany({
      [KEYS.user]: JSON.stringify(p.user),
      [KEYS.stores]: JSON.stringify(p.stores),
      [KEYS.storeId]: nextStoreId ?? '',
    })
  }

  async function withLogin(fn: () => Promise<AuthPayload>): Promise<boolean> {
    status.value = 'loading'
    error.value = null
    try {
      await applyAuth(await fn())
      return true
    } catch (e) {
      error.value =
        e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e)
      return false
    } finally {
      status.value = 'idle'
    }
  }

  function loginEmail(email: string, password: string): Promise<boolean> {
    return withLogin(() => api.loginEmail(email, password))
  }

  function registerEmail(name: string, email: string, password: string, role: 'owner' | 'staff' = 'owner'): Promise<boolean> {
    return withLogin(() => api.registerEmail(name, email, password, role))
  }

  async function loadAvailableStores(): Promise<void> {
    try { availableStoreOptions.value = (await api.availableStores()).stores } catch (e) { error.value = e instanceof Error ? e.message : String(e) }
  }

  async function joinStore(id: string): Promise<boolean> {
    try { await applyAuth(await api.joinStore(id)); availableStoreOptions.value = []; return true } catch (e) { error.value = e instanceof Error ? e.message : String(e); return false }
  }

  async function loadStaff(): Promise<void> {
    if (!currentStoreId.value || user.value?.account_role !== 'owner') { staffMembers.value = []; return }
    try { staffMembers.value = (await api.staff(currentStoreId.value)).staff } catch (e) { error.value = e instanceof Error ? e.message : String(e) }
  }

  async function updateStaff(uid: string, patch: { role?: 'staff' | 'manager'; permissions?: StaffPermission[] }): Promise<boolean> {
    if (!currentStoreId.value) return false
    try { const next = await api.updateStaff(currentStoreId.value, uid, patch); const i = staffMembers.value.findIndex((m) => m.uid === uid); if (i >= 0) staffMembers.value[i] = next; return true } catch (e) { error.value = e instanceof Error ? e.message : String(e); return false }
  }

  async function dismissStaff(uid: string): Promise<boolean> {
    if (!currentStoreId.value) return false
    try { await api.dismissStaff(currentStoreId.value, uid); const member = staffMembers.value.find((m) => m.uid === uid); if (member) member.status = 'dismissed'; return true } catch (e) { error.value = e instanceof Error ? e.message : String(e); return false }
  }

  function loginGoogle(): Promise<boolean> {
    return withLogin(async () => api.loginGoogle(await signInWithGoogle()))
  }

  /**
   * Pindah outlet aktif. Karena SQLite lokal single-tenant, data outlet lama
   * dibuang (`resetLocalBusinessData`) + cache media dikosongkan supaya tidak
   * bocor ke outlet baru; siklus sync berikutnya menarik ulang data outlet baru
   * dari nol. Antrean outbox pending sebaiknya sudah di-push sebelum ini
   * (ConnectPage menjalankan sync normal dulu). Guard ini tetap melindungi
   * pemanggil lain agar outbox pending/gagal tidak ikut terhapus.
   */
  async function setCurrentStore(id: string): Promise<boolean> {
    if (id === currentStoreId.value) return true
    return SyncEngine.duringOutletTransition(async () => {
      if (!(await canTransitionOutlets())) return false
      await resetAndActivateStore(id)
      return true
    })
  }

  async function canTransitionOutlets(): Promise<boolean> {
    const outbox = new OutboxRepository(getDb())
    await outbox.recoverMissingDirty(SYNC_ENTITIES)
    if ((await outbox.countUnresolved()) > 0) {
      error.value = UNRESOLVED_OUTBOX_ERROR
      return false
    }
    return true
  }

  async function resetAndActivateStore(id: string): Promise<void> {
    await resetLocalBusinessData()
    useMediaStore().clear()
    currentStoreId.value = id
    await repo().set(KEYS.storeId, id)
  }

  async function persistStores(): Promise<void> {
    await repo().set(KEYS.stores, JSON.stringify(stores.value))
  }

  /** Buat outlet baru → jadikan toko aktif. Balik true kalau sukses. */
  async function createStore(name: string): Promise<boolean> {
    status.value = 'loading'
    error.value = null
    try {
      return await SyncEngine.duringOutletTransition(async () => {
        if (!(await canTransitionOutlets())) return false
        const res = await api.createStore(name)
        stores.value = res.stores
        await persistStores()
        await resetAndActivateStore(String(res.store.id))
        return true
      })
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
      return false
    } finally {
      status.value = 'idle'
    }
  }

  /** Ganti nama outlet (khusus owner). Balik true kalau sukses. */
  async function renameStore(id: string | number, name: string): Promise<boolean> {
    error.value = null
    try {
      const res = await api.renameStore(id, name)
      const i = stores.value.findIndex((s) => String(s.id) === String(id))
      if (i !== -1) stores.value[i] = { ...stores.value[i], name: res.store.name }
      await persistStores()
      return true
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
      return false
    }
  }

  async function changePassword(currentPassword: string, nextPassword: string): Promise<boolean> {
    status.value = 'loading'
    error.value = null
    try {
      await api.changePassword(currentPassword, nextPassword)
      return true
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
      return false
    } finally {
      status.value = 'idle'
    }
  }

  async function deleteStore(id: string | number): Promise<boolean> {
    error.value = null
    try {
      return await SyncEngine.duringOutletTransition(async () => {
        if (!(await canTransitionOutlets())) return false
        const res = await api.deleteStore(id)
        stores.value = res.stores
        await persistStores()
        await resetLocalBusinessData()
        useMediaStore().clear()
        currentStoreId.value = res.currentStoreId
        await repo().set(KEYS.storeId, res.currentStoreId ?? '')
        return true
      })
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
      return false
    }
  }

  async function resetCloudData(password: string): Promise<boolean> {
    error.value = null
    if (!currentStoreId.value) {
      error.value = 'Belum ada outlet aktif.'
      return false
    }
    try {
      return await SyncEngine.duringOutletTransition(async () => {
        await api.resetStore(currentStoreId.value!, password)
        await resetLocalBusinessData()
        useMediaStore().clear()
        return true
      })
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
      return false
    }
  }

  async function clearSession(): Promise<void> {
    await clearAccountCredential(credentialStorage())
    token.value = null
    user.value = null
    stores.value = []
    availableStoreOptions.value = []
    staffMembers.value = []
    currentStoreId.value = null
    await repo().setMany({
      [KEYS.user]: '',
      [KEYS.stores]: '',
      [KEYS.storeId]: '',
    })
  }

  function clearSessionAfterUnauthorized(): void {
    void clearSession().catch((e: unknown) => {
      if (e instanceof SecureCredentialUnavailableError) {
        error.value = e.message
        return
      }
      if (e instanceof LegacyCredentialRemovalError) {
        error.value = e.message
        return
      }
      error.value = 'Gagal membersihkan sesi lokal.'
    })
  }

  async function logout(): Promise<void> {
    try {
      await api.logout()
    } catch {
      /* token mungkin sudah invalid — tetap bersihkan lokal */
    }
    try {
      await signOutGoogle()
    } finally {
      await clearSession()
    }
  }

  return {
    baseUrl,
    token,
    user,
    stores,
    availableStoreOptions,
    staffMembers,
    currentStoreId,
    status,
    error,
    isAuthenticated,
    currentStore,
    hasPermission,
    api,
    load,
    setBaseUrl,
    loginEmail,
    registerEmail,
    loadAvailableStores,
    joinStore,
    loadStaff,
    updateStaff,
    dismissStaff,
    loginGoogle,
    setCurrentStore,
    createStore,
    renameStore,
    changePassword,
    deleteStore,
    resetCloudData,
    logout,
  }
})
