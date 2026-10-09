import {
  createUserWithEmailAndPassword,
  deleteUser,
  EmailAuthProvider,
  getIdToken,
  reauthenticateWithCredential,
  signInWithEmailAndPassword,
  signOut,
  updatePassword,
  type User,
} from 'firebase/auth'
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
  runTransaction,
  setDoc,
  updateDoc,
  writeBatch,
  type DocumentReference,
  where,
} from 'firebase/firestore'
import { firebaseAuth, firebaseDb } from './config'
import type {
  AccountStore,
  AccountUser,
  AuthPayload,
  PublicStore,
  StaffMember,
  StaffPermission,
} from '@/services/api/client'
import { DEFAULT_STAFF_PERMISSIONS, STAFF_PERMISSIONS } from '@/services/api/client'
import type { ChangeEnvelope, PullResult, PushResult } from '@/services/sync/types'

const profileRef = (uid: string) => doc(firebaseDb, 'users', uid)
const storeRef = (id: string) => doc(firebaseDb, 'stores', id)
const memberRef = (storeId: string, uid: string) => doc(firebaseDb, 'stores', storeId, 'members', uid)
const entityRef = (storeId: string, entity: string, id: string) =>
  doc(firebaseDb, 'stores', storeId, entity, id)

const SYNC_ENTITIES = [
  'categories', 'products', 'media', 'cashier_sessions', 'sales', 'sale_items',
  'cashflow_categories', 'cashflow_entries',
] as const

interface ProfileData {
  name: string
  email: string
  stores: AccountStore[]
  current_store_id: string | null
  account_role?: 'owner' | 'staff'
}

function requireUser(): User {
  const user = firebaseAuth.currentUser
  if (!user) throw new Error('Sesi Firebase belum aktif. Silakan masuk kembali.')
  return user
}

async function tokenOf(user: User): Promise<string> {
  return getIdToken(user, true)
}

function userShape(user: User, currentStoreId: string | null, accountRole: 'owner' | 'staff' = 'owner', permissions?: StaffPermission[]): AccountUser {
  return {
    id: user.uid,
    name: user.displayName || user.email?.split('@')[0] || 'Kasir',
    email: user.email || '',
    avatar_url: user.photoURL,
    current_store_id: currentStoreId,
    account_role: accountRole,
    permissions: accountRole === 'owner' ? [...STAFF_PERMISSIONS] : permissions ?? [...DEFAULT_STAFF_PERMISSIONS],
  }
}

async function payloadFor(user: User): Promise<AuthPayload> {
  const profile = await getDoc(profileRef(user.uid))
  const data = profile.data() as Partial<ProfileData> | undefined
  const profileStores = Array.isArray(data?.stores) ? data.stores : []
  const stores: AccountStore[] = []
  let currentPermissions: StaffPermission[] | undefined
  for (const store of profileStores) {
    const membership = await getDoc(memberRef(String(store.id), user.uid))
    const status = !membership.exists() || membership.data()?.status === 'dismissed' ? 'dismissed' : 'active'
    if (membership.exists() && status === 'active' && String(store.id) === String(data?.current_store_id)) {
      currentPermissions = Array.isArray(membership.data()?.permissions) ? membership.data()?.permissions as StaffPermission[] : [...DEFAULT_STAFF_PERMISSIONS]
    }
    const cloudStore = membership.exists() ? await getDoc(storeRef(String(store.id))) : null
    stores.push({ ...store, ...(cloudStore?.exists() ? { name: String(cloudStore.data()?.name ?? store.name), logo_ref: (cloudStore.data()?.logo_ref as string | null | undefined) ?? null } : {}), status })
  }
  if (data?.account_role === 'staff') {
    const candidates = await getDocs(query(collection(firebaseDb, 'stores'), where('staff_signup_enabled', '==', true)))
    for (const candidate of candidates.docs) {
      if (stores.some((store) => String(store.id) === candidate.id)) continue
      const membership = await getDoc(memberRef(candidate.id, user.uid))
      if (!membership.exists() || membership.data()?.status !== 'active') continue
      const candidateData = candidate.data()
      stores.push({ id: candidate.id, name: String(candidateData.name ?? 'Outlet'), role: membership.data()?.role === 'manager' ? 'manager' : 'staff', status: 'active', logo_ref: (candidateData.logo_ref as string | null | undefined) ?? null })
    }
  }
  const active = stores.filter((store) => store.status !== 'dismissed')
  const requested = data?.current_store_id ? active.find((store) => String(store.id) === String(data.current_store_id)) : null
  const currentStoreId = requested?.id || active[0]?.id || null
  if (!currentPermissions && currentStoreId && data?.account_role === 'staff') {
    const membership = await getDoc(memberRef(String(currentStoreId), user.uid))
    const permissions = membership.data()?.permissions
    currentPermissions = Array.isArray(permissions) ? permissions as StaffPermission[] : [...DEFAULT_STAFF_PERMISSIONS]
  }
  return { token: await tokenOf(user), user: userShape(user, currentStoreId == null ? null : String(currentStoreId), data?.account_role ?? 'owner', currentPermissions), stores }
}

export class FirebaseApiClient {
  async loginEmail(email: string, password: string): Promise<AuthPayload> {
    const credential = await signInWithEmailAndPassword(firebaseAuth, email, password)
    return payloadFor(credential.user)
  }

  async registerEmail(name: string, email: string, password: string, accountRole: 'owner' | 'staff' = 'owner'): Promise<AuthPayload> {
    const credential = await createUserWithEmailAndPassword(firebaseAuth, email, password)
    if (accountRole === 'staff') {
      await setDoc(profileRef(credential.user.uid), {
        name: name.trim() || 'Staf', email, account_role: 'staff', stores: [], current_store_id: null,
      })
      return payloadFor(credential.user)
    }
    const storeId = crypto.randomUUID()
    const store: AccountStore = { id: storeId, name: name.trim() || 'Shakala Bakery', role: 'owner' }
    await setDoc(storeRef(storeId), {
      name: store.name,
      owner_id: credential.user.uid,
      created_at: Date.now(), staff_signup_enabled: true,
    })
    await setDoc(memberRef(storeId, credential.user.uid), { role: 'owner', uid: credential.user.uid, status: 'active', name: name.trim() || 'Owner', email, permissions: STAFF_PERMISSIONS })
    await setDoc(profileRef(credential.user.uid), {
      name: name.trim() || 'Kasir',
      email,
      stores: [store],
      current_store_id: storeId,
      account_role: 'owner',
    })
    return payloadFor(credential.user)
  }

  async me(): Promise<{ user: AccountUser; stores: AccountStore[] }> {
    return payloadFor(requireUser()).then(({ user, stores }) => ({ user, stores }))
  }

  async logout(): Promise<void> {
    await signOut(firebaseAuth)
  }

  async stores(): Promise<{ stores: AccountStore[] }> {
    const profile = await getDoc(profileRef(requireUser().uid))
    const data = profile.data() as Partial<ProfileData> | undefined
    return { stores: Array.isArray(data?.stores) ? data.stores : [] }
  }

  async createStore(name: string): Promise<{ store: AccountStore; stores: AccountStore[] }> {
    const user = requireUser()
    const profile = await this.stores()
    const store: AccountStore = { id: crypto.randomUUID(), name: name.trim(), role: 'owner' }
    await setDoc(storeRef(String(store.id)), { name: store.name, owner_id: user.uid, created_at: Date.now(), staff_signup_enabled: true })
    await setDoc(memberRef(String(store.id), user.uid), { role: 'owner', uid: user.uid, status: 'active', name: user.displayName || 'Owner', email: user.email || '', permissions: STAFF_PERMISSIONS })
    const stores = [...profile.stores, store]
    await updateDoc(profileRef(user.uid), { stores, current_store_id: String(store.id) })
    return { store, stores }
  }

  async availableStores(): Promise<{ stores: PublicStore[] }> {
    requireUser()
    const result = await getDocs(query(collection(firebaseDb, 'stores'), where('staff_signup_enabled', '==', true)))
    return { stores: result.docs.map((row) => ({ id: row.id, name: String(row.data().name ?? 'Outlet') })).sort((a, b) => a.name.localeCompare(b.name)) }
  }

  async joinStore(storeId: string): Promise<AuthPayload> {
    const user = requireUser()
    const store = await getDoc(storeRef(storeId))
    if (!store.exists() || store.data()?.staff_signup_enabled !== true) throw new Error('Outlet tidak tersedia untuk pendaftaran staf.')
    const profile = await this.stores()
    const nextStore: AccountStore = { id: storeId, name: String(store.data()?.name ?? 'Outlet'), role: 'staff', status: 'active' }
    const stores = [...profile.stores.filter((item) => String(item.id) !== storeId), nextStore]
    await setDoc(memberRef(storeId, user.uid), {
      uid: user.uid, role: 'staff', status: 'active', name: user.displayName || user.email?.split('@')[0] || 'Staf', email: user.email || '', permissions: DEFAULT_STAFF_PERMISSIONS,
    })
    await updateDoc(profileRef(user.uid), { stores, current_store_id: storeId, account_role: 'staff' })
    return payloadFor(user)
  }

  async staff(storeId: string): Promise<{ staff: StaffMember[] }> {
    await this.requireOwner(storeId)
    // Backfill outlet lama agar ikut muncul pada pilihan pendaftaran staf.
    await updateDoc(storeRef(storeId), { staff_signup_enabled: true })
    const result = await getDocs(collection(firebaseDb, 'stores', storeId, 'members'))
    const staff: StaffMember[] = result.docs.filter((row) => row.data().role !== 'owner').map((row): StaffMember => {
      const data = row.data()
      return { uid: row.id, name: String(data.name ?? 'Staf'), email: String(data.email ?? ''), role: data.role === 'manager' ? 'manager' : 'staff', status: data.status === 'dismissed' ? 'dismissed' : 'active', permissions: Array.isArray(data.permissions) ? data.permissions.filter((p): p is StaffPermission => STAFF_PERMISSIONS.includes(p)) : [...DEFAULT_STAFF_PERMISSIONS] }
    })
    return { staff }
  }

  async updateStaff(storeId: string, uid: string, patch: { role?: 'staff' | 'manager'; permissions?: StaffPermission[] }): Promise<StaffMember> {
    await this.requireOwner(storeId)
    const reference = memberRef(storeId, uid)
    const current = await getDoc(reference)
    if (!current.exists() || current.data()?.role === 'owner') throw new Error('Staf tidak ditemukan.')
    await updateDoc(reference, { ...patch, permissions: patch.permissions ?? current.data()?.permissions ?? DEFAULT_STAFF_PERMISSIONS })
    const data: Record<string, unknown> = { ...current.data(), ...patch }
    return { uid, name: String(data.name ?? 'Staf'), email: String(data.email ?? ''), role: data.role === 'manager' ? 'manager' : 'staff', status: data.status === 'dismissed' ? 'dismissed' : 'active', permissions: Array.isArray(data.permissions) ? data.permissions as StaffPermission[] : [...DEFAULT_STAFF_PERMISSIONS] }
  }

  async dismissStaff(storeId: string, uid: string): Promise<void> {
    await this.requireOwner(storeId)
    const reference = memberRef(storeId, uid)
    const current = await getDoc(reference)
    if (!current.exists() || current.data()?.role === 'owner') throw new Error('Staf tidak ditemukan.')
    await updateDoc(reference, { status: 'dismissed', dismissed_at: Date.now() })
  }

  async transferStaff(fromStoreId: string, toStoreId: string, uid: string): Promise<void> {
    await this.requireOwner(fromStoreId)
    await this.requireOwner(toStoreId)
    if (fromStoreId === toStoreId) throw new Error('Outlet tujuan harus berbeda.')
    const source = await getDoc(memberRef(fromStoreId, uid))
    const targetStore = await getDoc(storeRef(toStoreId))
    if (!source.exists() || source.data()?.role === 'owner') throw new Error('Staf tidak ditemukan.')
    if (!targetStore.exists()) throw new Error('Outlet tujuan tidak ditemukan.')
    await setDoc(memberRef(toStoreId, uid), { ...source.data(), status: 'active', transferred_at: Date.now() })
    await deleteDoc(memberRef(fromStoreId, uid))
  }

  async updateStoreBranding(id: string | number, name: string, logoRef: string | null): Promise<{ store: AccountStore }> {
    const user = await this.requireOwner(String(id))
    const profile = await this.stores()
    const existing = profile.stores.find((store) => String(store.id) === String(id))
    if (!existing) throw new Error('Toko tidak ditemukan.')
    const store: AccountStore = { ...existing, name: name.trim(), logo_ref: logoRef }
    await updateDoc(storeRef(String(id)), { name: store.name, logo_ref: logoRef })
    await updateDoc(profileRef(user.uid), { stores: profile.stores.map((item) => String(item.id) === String(id) ? store : item) })
    return { store }
  }

  async renameStore(id: string | number, name: string): Promise<{ store: AccountStore }> {
    const user = requireUser()
    const profile = await this.stores()
    const existing = profile.stores.find((store) => String(store.id) === String(id))
    if (!existing) throw new Error('Toko tidak ditemukan.')
    const store = { ...existing, name: name.trim() }
    await updateDoc(storeRef(String(id)), { name: store.name })
    await updateDoc(profileRef(user.uid), { stores: profile.stores.map((item) => item.id === existing.id ? store : item) })
    return { store }
  }

  private async requireOwner(storeId: string): Promise<User> {
    const user = requireUser()
    const store = await getDoc(storeRef(storeId))
    if (!store.exists() || store.data()?.owner_id !== user.uid) throw new Error('Hanya owner yang dapat melakukan tindakan ini.')
    return user
  }

  private async deleteStoreChildren(storeId: string, includeStore: boolean): Promise<void> {
    const refs: DocumentReference[] = []
    for (const entity of SYNC_ENTITIES) {
      const rows = await getDocs(collection(firebaseDb, 'stores', storeId, entity))
      refs.push(...rows.docs.map((row) => row.ref))
    }
    const members = await getDocs(collection(firebaseDb, 'stores', storeId, 'members'))
    refs.push(...members.docs.map((row) => row.ref))
    if (includeStore) refs.push(storeRef(storeId))
    for (let i = 0; i < refs.length; i += 450) {
      const batch = writeBatch(firebaseDb)
      for (const reference of refs.slice(i, i + 450)) batch.delete(reference)
      await batch.commit()
    }
  }

  async changePassword(currentPassword: string, nextPassword: string): Promise<void> {
    const user = requireUser()
    if (!user.email) throw new Error('Akun ini tidak menggunakan login email dan password.')
    await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, currentPassword))
    await updatePassword(user, nextPassword)
  }

  async deleteStore(id: string | number): Promise<{ stores: AccountStore[]; currentStoreId: string | null }> {
    const user = await this.requireOwner(String(id))
    const profile = await this.stores()
    if (!profile.stores.some((store) => String(store.id) === String(id))) throw new Error('Outlet tidak ditemukan.')
    await this.deleteStoreChildren(String(id), true)
    const stores = profile.stores.filter((store) => String(store.id) !== String(id))
    const currentStoreId = stores[0] ? String(stores[0].id) : null
    await updateDoc(profileRef(user.uid), { stores, current_store_id: currentStoreId })
    return { stores, currentStoreId }
  }

  async resetStore(storeId: string, password: string): Promise<void> {
    const user = await this.requireOwner(storeId)
    if (user.email?.toLowerCase() !== 'ktopa58@gmail.com') throw new Error('Reset data cloud hanya tersedia untuk akun utama.')
    if (!user.email) throw new Error('Akun ini tidak menggunakan login email dan password.')
    await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, password))
    await this.deleteStoreChildren(storeId, false)
    await setDoc(memberRef(storeId, user.uid), { role: 'owner', uid: user.uid })
  }

  async deleteAccount(password: string): Promise<void> {
    const user = requireUser()
    if (!user.email) throw new Error('Akun ini tidak menggunakan login email dan password.')
    await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, password))
    // Profil, membership, dan seluruh aktivitas sengaja dipertahankan sebagai jejak audit.
    await setDoc(profileRef(user.uid), {
      account_deleted: true,
      deleted_at: Date.now(),
      name: 'Akun dihapus',
      email: user.email,
    }, { merge: true })
    await deleteUser(user)
  }

  async syncPush(changes: ChangeEnvelope[], storeId: string): Promise<PushResult> {
    const acked: string[] = []
    const rejected: { id: string; reason: string }[] = []
    for (const change of changes) {
      try {
        const result = await runTransaction(firebaseDb, async (transaction) => {
          const reference = entityRef(storeId, change.entity, change.entityId)
          const current = await transaction.get(reference)
          const incoming = Number((change.payload as Record<string, unknown>).updated_at ?? change.createdAt)
          const stored = Number(current.data()?.updated_at ?? 0)
          if (current.exists() && incoming <= stored) return 'stale'
          const payload: Record<string, unknown> = {
            ...(change.payload as Record<string, unknown>),
            sync_version: Number(current.data()?.sync_version ?? 0) + 1,
          }
          if (change.op === 'delete') payload.deleted_at = payload.deleted_at ?? change.createdAt
          transaction.set(reference, payload, { merge: true })
          return 'acked'
        })
        if (result === 'acked') {
          acked.push(change.id)
        } else {
          // Cloud already contains a newer version. Treat this as resolved:
          // pull() will make the local copy converge to the cloud version.
          // Keeping it as a failed outbox row makes a successful sync look
          // broken forever and causes the same stale write to be retried.
          acked.push(change.id)
        }
      } catch (error) {
        rejected.push({ id: change.id, reason: error instanceof Error ? error.message : 'write_failed' })
      }
    }
    return { acked, rejected }
  }

  async syncPull(entity: string, since: number, storeId: string): Promise<PullResult> {
    const source = collection(firebaseDb, 'stores', storeId, entity)
    const result = await getDocs(query(source, where('updated_at', '>', since), orderBy('updated_at', 'asc')))
    const changes: Record<string, unknown>[] = result.docs.map((item) => ({ id: item.id, ...item.data() }))
    const cursor = changes.reduce((max, row) => Math.max(max, Number(row.updated_at ?? since)), since)
    return { entity, changes, cursor }
  }
}
