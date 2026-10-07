<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { storeToRefs } from 'pinia'
import AppHeader from '@/components/layout/AppHeader.vue'
import BottomSheet from '@/components/common/BottomSheet.vue'
import ConnectAuthCard from '@/components/settings/ConnectAuthCard.vue'
import SyncStatusCard from '@/components/settings/SyncStatusCard.vue'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Loader2, LogOut, Check, AlertCircle, Plus, Pencil, Trash2, KeyRound, RotateCcw, UserRound, UserX, ShieldCheck } from 'lucide-vue-next'
import { Capacitor } from '@capacitor/core'
import { useAccountStore } from '@/stores/account'
import { STAFF_PERMISSIONS, type StaffPermission } from '@/services/api/client'
import { useSyncStore } from '@/stores/sync'
import { ENV_GOOGLE_CLIENT_ID } from '@/services/api/config'
import {
  LegacyCredentialRemovalError,
  SecureCredentialUnavailableError,
} from '@/services/auth/accountCredentials'

const account = useAccountStore()
const sync = useSyncStore()
const { isAuthenticated, user, stores, currentStoreId, status, error } =
  storeToRefs(account)
const { status: syncStatus, pending, failedChanges, failedCount, lastError, lastSyncedAt } =
  storeToRefs(sync)

const mode = ref<'login' | 'register'>('login')
const name = ref('')
const email = ref('')
const password = ref('')
const password2 = ref('')
const accountRole = ref<'owner' | 'staff'>('owner')
const localError = ref('')
// Google native cuma jalan di aplikasi Android (butuh SHA-1 + OAuth client Android).
// Di web, sengaja dimatiin biar gak kena redirect_uri_mismatch — pakai email/password.
const isNative = Capacitor.isNativePlatform()
const hasGoogle = computed(() => !!ENV_GOOGLE_CLIENT_ID && isNative)

onMounted(() => {
  void sync.refreshPending()
  if (isAuthenticated.value && user.value?.account_role === 'staff' && !currentStoreId.value) void account.loadAvailableStores()
  if (isAuthenticated.value && user.value?.account_role === 'owner' && currentStoreId.value) void account.loadStaff()
})

function switchMode(m: 'login' | 'register') {
  mode.value = m
  localError.value = ''
  account.error = null
}

async function onSubmit() {
  localError.value = ''
  let ok = false
  if (mode.value === 'register') {
    if (!name.value.trim()) {
      localError.value = 'Nama wajib diisi.'
      return
    }
    if (password.value !== password2.value) {
      localError.value = 'Konfirmasi kata sandi tidak cocok.'
      return
    }
    ok = await account.registerEmail(name.value.trim(), email.value.trim(), password.value, accountRole.value)
  } else {
    ok = await account.loginEmail(email.value.trim(), password.value)
  }
  if (ok) {
    password.value = ''
    password2.value = ''
    await sync.start()
    await sync.syncNow()
    if (account.user?.account_role === 'staff' && !account.currentStoreId) await account.loadAvailableStores()
  }
}

async function onGoogleLogin() {
  if (await account.loginGoogle()) {
    await sync.start()
    await sync.syncNow()
  }
}

async function onLogout() {
  await sync.stop()
  try {
    await account.logout()
  } catch (error) {
    if (
      error instanceof SecureCredentialUnavailableError ||
      error instanceof LegacyCredentialRemovalError
    ) {
      account.error = 'Gagal keluar dengan aman. Kredensial perangkat belum dihapus.'
      return
    }
    account.error = 'Gagal keluar. Coba lagi.'
  }
}

// Ganti outlet = destruktif (data lokal outlet lama di-reset) → wajib konfirmasi.
const pendingSwitch = ref<{ id: string; name: string } | null>(null)
const switching = ref(false)
const outletTransitionError = ref('')

function askSwitch(s: { id: string | number; name: string }) {
  outletTransitionError.value = ''
  pendingSwitch.value = { id: String(s.id), name: s.name }
}

async function prepareOutletTransition(): Promise<boolean> {
  outletTransitionError.value = ''
  await sync.syncNow()
  await sync.refreshPending()

  if (pending.value === 0 && failedCount.value === 0) return true

  outletTransitionError.value =
    failedCount.value > 0
      ? 'Perubahan belum aman disinkronkan. Ada perubahan gagal; gunakan Coba lagi terlebih dahulu sebelum pindah outlet.'
      : 'Perubahan belum aman disinkronkan. Periksa koneksi lalu sinkronkan kembali sebelum pindah outlet.'
  return false
}

async function confirmSwitch() {
  const target = pendingSwitch.value
  if (!target || switching.value) return
  switching.value = true
  try {
    if (!(await prepareOutletTransition())) return
    if (!(await account.setCurrentStore(target.id))) {
      outletTransitionError.value = account.error ?? outletTransitionError.value
      return
    }
    pendingSwitch.value = null
    await sync.syncNow()
  } finally {
    switching.value = false
  }
}

// --- Kelola outlet ---
const showAddStore = ref(false)
const newStoreName = ref('')
const editingId = ref<string | null>(null)
const editName = ref('')
const showPassword = ref(false)
const oldPassword = ref('')
const newPassword = ref('')
const newPassword2 = ref('')
const passwordBusy = ref(false)
const passwordMessage = ref('')
const deleteTarget = ref<{ id: string; name: string } | null>(null)
const deleteBusy = ref(false)
const resetOpen = ref(false)
const resetPassword = ref('')
const resetConfirm = ref('')
const resetBusy = ref(false)
const managerBusy = ref(false)
const staffMessage = ref('')
const permissionLabels: Record<StaffPermission, string> = { cashier: 'Kasir', products: 'Produk', cashflow: 'Cashflow', reports: 'Laporan', settings: 'Pengaturan' }

async function onAddStore() {
  const storeName = newStoreName.value.trim()
  if (!storeName || switching.value) return
  switching.value = true
  try {
    if (!(await prepareOutletTransition())) return
    if (!(await account.createStore(storeName))) {
      outletTransitionError.value = account.error ?? outletTransitionError.value
      return
    }
    newStoreName.value = ''
    showAddStore.value = false
    await sync.syncNow()
  } finally {
    switching.value = false
  }
}

function startRename(s: { id: string | number; name: string }) {
  editingId.value = String(s.id)
  editName.value = s.name
}

async function onRename(s: { id: string | number }) {
  if (!editName.value.trim()) return
  if (await account.renameStore(s.id, editName.value.trim())) editingId.value = null
}

async function onChangePassword() {
  passwordMessage.value = ''
  if (!oldPassword.value || newPassword.value.length < 6 || newPassword.value !== newPassword2.value) {
    passwordMessage.value = 'Password lama wajib diisi. Password baru minimal 6 karakter dan harus sama dengan konfirmasi.'
    return
  }
  passwordBusy.value = true
  try {
    if (await account.changePassword(oldPassword.value, newPassword.value)) {
      oldPassword.value = ''; newPassword.value = ''; newPassword2.value = ''
      passwordMessage.value = 'Password berhasil diubah.'
      showPassword.value = false
    } else passwordMessage.value = account.error ?? 'Password gagal diubah.'
  } finally { passwordBusy.value = false }
}

async function confirmDeleteStore() {
  const target = deleteTarget.value
  if (!target || deleteBusy.value) return
  deleteBusy.value = true
  try {
    if (await account.deleteStore(target.id)) { deleteTarget.value = null; await sync.syncNow() }
  } finally { deleteBusy.value = false }
}

async function confirmResetCloud() {
  if (resetConfirm.value !== 'RESET' || !resetPassword.value || resetBusy.value) return
  resetBusy.value = true
  try {
    if (await account.resetCloudData(resetPassword.value)) {
      resetOpen.value = false; resetPassword.value = ''; resetConfirm.value = ''
      await sync.syncNow()
    }
  } finally { resetBusy.value = false }
}

async function chooseStaffStore(id: string) {
  if (!await account.joinStore(id)) return
  await sync.start(); await sync.syncNow()
}

async function updateStaffPermission(uid: string, permission: StaffPermission, enabled: boolean) {
  const member = account.staffMembers.find((item) => item.uid === uid)
  if (!member || managerBusy.value) return
  managerBusy.value = true
  const permissions = enabled ? [...new Set([...member.permissions, permission])] : member.permissions.filter((item) => item !== permission)
  try { await account.updateStaff(uid, { permissions }) } finally { managerBusy.value = false }
}

async function changeStaffRole(uid: string, role: 'staff' | 'manager') {
  managerBusy.value = true
  try { await account.updateStaff(uid, { role }) } finally { managerBusy.value = false }
}

async function dismissStaffMember(uid: string) {
  if (!confirm('Bebastugaskan staf ini? Aksesnya ke outlet akan langsung dihentikan.')) return
  managerBusy.value = true
  try { await account.dismissStaff(uid); staffMessage.value = 'Staf dibebastugaskan.' } finally { managerBusy.value = false }
}

const syncLabel = computed(() => {
  if (failedCount.value > 0) return 'Perlu perhatian'

  switch (syncStatus.value) {
    case 'syncing':
      return 'Menyinkronkan…'
    case 'idle':
      return 'Tersinkron'
    case 'offline':
      return 'Offline'
    case 'error':
      return 'Gagal sync'
    default:
      return 'Nonaktif'
  }
})

</script>

<template>
  <div class="min-h-screen bg-background pb-10">
    <AppHeader title="Sambungkan ke POS Pro" subtitle="Login online & sync cloud" back />
    <div class="space-y-5 p-4">
      <ConnectAuthCard
        v-if="!isAuthenticated"
        :mode="mode" :name="name" :email="email" :password="password" :password2="password2"
        :loading="status === 'loading'" :status="status" :local-error="localError" :account-role="accountRole"
        :account-error="error" :has-google="hasGoogle"
        @update:mode="switchMode" @update:name="name = $event" @update:email="email = $event"
        @update:password="password = $event" @update:password2="password2 = $event"
        @update:account-role="accountRole = $event"
        @submit="onSubmit" @google-login="onGoogleLogin"
      />
      <template v-else>
        <p v-if="error" class="flex items-start gap-1.5 text-xs text-destructive" role="alert"><AlertCircle class="mt-0.5 size-3.5 shrink-0" /> {{ error }}</p>
        <Card class="border-primary/30 bg-primary/5">
          <CardContent class="space-y-1 p-4">
            <div class="flex items-center gap-2"><Check class="size-4 text-success" /><p class="text-sm font-semibold">{{ user?.name }}</p></div>
            <p class="text-xs text-muted-foreground">{{ user?.email }}</p>
          </CardContent>
        </Card>
        <Card v-if="user?.account_role === 'staff' && !currentStoreId" class="border-primary/30">
          <CardContent class="space-y-3 p-4">
            <div><p class="font-semibold">Pilih outlet untuk mulai bekerja</p><p class="text-xs text-muted-foreground">Daftar outlet diambil dari cloud.</p></div>
            <Button v-for="store in account.availableStoreOptions" :key="store.id" variant="outline" class="w-full justify-between" @click="chooseStaffStore(store.id)"><span>{{ store.name }}</span><UserRound class="size-4" /></Button>
            <p v-if="!account.availableStoreOptions.length" class="text-sm text-muted-foreground">Belum ada outlet yang membuka pendaftaran staf.</p>
          </CardContent>
        </Card>
        <Card v-if="user?.account_role === 'staff' && stores.some((s) => s.status === 'dismissed')" class="border-destructive/40 bg-destructive/5">
          <CardContent class="flex items-start gap-3 p-4"><UserX class="mt-0.5 size-5 text-destructive" /><div><p class="font-semibold text-destructive">Anda dibebastugaskan!</p><p class="text-sm text-muted-foreground">Akses Anda ke outlet tersebut telah dihentikan oleh owner.</p></div></CardContent>
        </Card>
        <section v-if="stores.length" class="space-y-2">
          <div class="flex items-center justify-between">
            <Label>Outlet</Label>
            <Button variant="ghost" size="sm" class="h-7 gap-1 text-primary" @click="showAddStore = !showAddStore"><Plus class="size-4" /> Tambah</Button>
          </div>
          <div v-if="showAddStore" class="flex items-center gap-2">
            <Input v-model="newStoreName" placeholder="Nama outlet baru" @keyup.enter="onAddStore" />
            <Button size="sm" :disabled="status === 'loading' || switching || !newStoreName.trim()" @click="onAddStore">Simpan</Button>
          </div>
          <p v-if="outletTransitionError" class="flex items-start gap-1.5 text-xs text-destructive" role="alert"><AlertCircle class="mt-0.5 size-3.5 shrink-0" /> {{ outletTransitionError }}</p>
          <div class="space-y-2">
            <div v-for="s in stores" :key="String(s.id)" class="flex items-center gap-2 rounded-lg border p-3 text-sm" :class="String(s.id) === currentStoreId ? 'border-primary bg-primary/10' : 'border-border'">
              <template v-if="editingId === String(s.id)">
                <Input v-model="editName" class="h-8 flex-1" @keyup.enter="onRename(s)" />
                <Button size="sm" class="h-8" @click="onRename(s)">OK</Button>
                <Button size="sm" variant="ghost" class="h-8" @click="editingId = null">Batal</Button>
              </template>
              <template v-else>
                <div class="flex min-w-0 flex-1 items-center gap-2">
                  <span class="truncate font-medium">{{ s.name }}</span><Badge variant="secondary">{{ s.role }}</Badge>
                  <Badge v-if="String(s.id) === currentStoreId" class="bg-primary/15 text-primary hover:bg-primary/15">Aktif</Badge>
                </div>
                <Button v-if="String(s.id) !== currentStoreId" size="sm" variant="outline" class="h-8" @click="askSwitch(s)">Ganti</Button>
                <template v-if="s.role === 'owner'">
                  <button class="text-muted-foreground transition active:text-foreground" aria-label="Ganti nama outlet" @click="startRename(s)"><Pencil class="size-4" /></button>
                  <button class="text-destructive" aria-label="Hapus outlet" @click="deleteTarget = { id: String(s.id), name: s.name }"><Trash2 class="size-4" /></button>
                </template>
              </template>
            </div>
          </div>
        </section>
        <section v-if="user?.account_role === 'owner' && currentStoreId" class="space-y-3 rounded-xl border p-4">
          <div class="flex items-center justify-between"><div><p class="font-semibold">Manajemen staf</p><p class="text-xs text-muted-foreground">Atur peran dan izin setiap staf outlet.</p></div><Button size="sm" variant="outline" @click="account.loadStaff()"><ShieldCheck class="size-4" /> Muat</Button></div>
          <p v-if="staffMessage" class="text-xs text-success">{{ staffMessage }}</p>
          <p v-if="!account.staffMembers.length" class="text-sm text-muted-foreground">Belum ada staf yang bergabung.</p>
          <div v-for="member in account.staffMembers" :key="member.uid" class="space-y-3 rounded-lg bg-muted/40 p-3">
            <div class="flex items-center gap-2"><div class="min-w-0 flex-1"><p class="truncate font-medium">{{ member.name }}</p><p class="truncate text-xs text-muted-foreground">{{ member.email }}</p></div><Badge :variant="member.status === 'dismissed' ? 'destructive' : 'secondary'">{{ member.status === 'dismissed' ? 'Dibebastugaskan' : member.role }}</Badge></div>
            <div v-if="member.status === 'active'" class="grid grid-cols-2 gap-2 text-xs"><label v-for="permission in STAFF_PERMISSIONS" :key="permission" class="flex items-center gap-2"><input type="checkbox" :checked="member.permissions.includes(permission)" @change="updateStaffPermission(member.uid, permission, ($event.target as HTMLInputElement).checked)" /> {{ permissionLabels[permission] }}</label></div>
            <div v-if="member.status === 'active'" class="flex gap-2"><Button size="sm" variant="outline" @click="changeStaffRole(member.uid, member.role === 'manager' ? 'staff' : 'manager')">Jadikan {{ member.role === 'manager' ? 'staf' : 'manajer' }}</Button><Button size="sm" variant="ghost" class="text-destructive" @click="dismissStaffMember(member.uid)"><UserX class="size-4" /> Bebastugaskan</Button></div>
          </div>
        </section>
        <BottomSheet :open="!!pendingSwitch" title="Ganti outlet?" @update:open="(v: boolean) => { if (!v && !switching) pendingSwitch = null }">
          <div class="space-y-4 p-5">
            <p class="text-sm text-muted-foreground">Pindah ke <span class="font-semibold text-foreground">{{ pendingSwitch?.name }}</span>? Data outlet saat ini akan dibersihkan dari perangkat lalu diganti data outlet tujuan. Perubahan yang belum tersinkron dikirim dulu — data di server tetap aman.</p>
            <p v-if="outletTransitionError" class="flex items-start gap-1.5 text-xs text-destructive" role="alert"><AlertCircle class="mt-0.5 size-3.5 shrink-0" /> {{ outletTransitionError }}</p>
            <div class="flex gap-2">
              <Button variant="outline" class="flex-1" :disabled="switching" @click="pendingSwitch = null">Batal</Button>
              <Button class="flex-1" :disabled="switching" @click="confirmSwitch"><Loader2 v-if="switching" class="size-4 animate-spin" /> Ya, ganti</Button>
            </div>
          </div>
        </BottomSheet>
        <SyncStatusCard
          :sync-status="syncStatus" :sync-label="syncLabel" :pending="pending" :last-error="lastError"
          :last-synced-at="lastSyncedAt" :failed-changes="failedChanges" :failed-count="failedCount"
          @sync="sync.syncNow()" @retry="sync.retryFailed()"
        />
        <section class="space-y-2">
          <Button variant="outline" class="w-full justify-start" @click="showPassword = !showPassword"><KeyRound class="size-4" /> Ubah password akun online</Button>
          <div v-if="showPassword" class="space-y-3 rounded-lg border p-4">
            <Input v-model="oldPassword" type="password" placeholder="Password saat ini" autocomplete="current-password" />
            <Input v-model="newPassword" type="password" placeholder="Password baru" autocomplete="new-password" />
            <Input v-model="newPassword2" type="password" placeholder="Ulangi password baru" autocomplete="new-password" />
            <p v-if="passwordMessage" class="text-xs" :class="passwordMessage.includes('berhasil') ? 'text-success' : 'text-destructive'">{{ passwordMessage }}</p>
            <Button class="w-full" :disabled="passwordBusy" @click="onChangePassword"><Loader2 v-if="passwordBusy" class="size-4 animate-spin" /> Simpan password</Button>
          </div>
          <Button variant="outline" class="w-full justify-start text-destructive" @click="resetOpen = true"><RotateCcw class="size-4" /> Reset semua data cloud</Button>
        </section>
        <Button variant="outline" class="w-full text-destructive" @click="onLogout"><LogOut class="size-4" /> Keluar</Button>
      </template>
    </div>

    <BottomSheet :open="!!deleteTarget" title="Hapus outlet?" @update:open="(v: boolean) => { if (!v && !deleteBusy) deleteTarget = null }">
      <div class="space-y-4 p-5">
        <p class="text-sm">Outlet <strong>{{ deleteTarget?.name }}</strong> dan seluruh transaksi, produk, kategori, serta data sinkronisasinya akan dihapus permanen dari cloud.</p>
        <p class="text-xs text-destructive">Tindakan ini tidak dapat dibatalkan. Pastikan outlet yang dipilih benar.</p>
        <div class="flex gap-2"><Button variant="outline" class="flex-1" :disabled="deleteBusy" @click="deleteTarget = null">Batal</Button><Button variant="destructive" class="flex-1" :disabled="deleteBusy" @click="confirmDeleteStore"><Loader2 v-if="deleteBusy" class="size-4 animate-spin" /> Hapus permanen</Button></div>
      </div>
    </BottomSheet>

    <BottomSheet :open="resetOpen" title="Reset semua data cloud" @update:open="(v: boolean) => { if (!v && !resetBusy) resetOpen = false }">
      <div class="space-y-4 p-5">
        <div class="space-y-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
          <p class="font-semibold text-destructive">Peringatan penting</p>
          <p>Reset akan menghapus permanen semua data outlet aktif dari cloud: transaksi, produk, stok, kategori, cashflow, sesi kasir, dan media.</p>
          <p class="font-semibold">Data yang sudah di-reset tidak bisa dikembalikan.</p>
        </div>
        <Label>Ketik <strong>RESET</strong> untuk konfirmasi</Label>
        <Input v-model="resetConfirm" placeholder="RESET" autocomplete="off" />
        <Label>Password akun online</Label>
        <Input v-model="resetPassword" type="password" placeholder="Password untuk verifikasi" autocomplete="current-password" />
        <p v-if="account.error" class="text-xs text-destructive">{{ account.error }}</p>
        <div class="flex gap-2"><Button variant="outline" class="flex-1" :disabled="resetBusy" @click="resetOpen = false">Batal</Button><Button variant="destructive" class="flex-1" :disabled="resetBusy || resetConfirm !== 'RESET' || !resetPassword" @click="confirmResetCloud"><Loader2 v-if="resetBusy" class="size-4 animate-spin" /> Reset permanen</Button></div>
      </div>
    </BottomSheet>
  </div>
</template>
