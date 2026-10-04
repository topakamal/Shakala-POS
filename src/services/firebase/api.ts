import {
  createUserWithEmailAndPassword,
  getIdToken,
  signInWithEmailAndPassword,
  signOut,
  type User,
} from 'firebase/auth'
import {
  collection,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
  runTransaction,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore'
import { firebaseAuth, firebaseDb } from './config'
import type {
  AccountStore,
  AccountUser,
  AuthPayload,
} from '@/services/api/client'
import type { ChangeEnvelope, PullResult, PushResult } from '@/services/sync/types'

const profileRef = (uid: string) => doc(firebaseDb, 'users', uid)
const storeRef = (id: string) => doc(firebaseDb, 'stores', id)
const memberRef = (storeId: string, uid: string) => doc(firebaseDb, 'stores', storeId, 'members', uid)
const entityRef = (storeId: string, entity: string, id: string) =>
  doc(firebaseDb, 'stores', storeId, entity, id)

interface ProfileData {
  name: string
  email: string
  stores: AccountStore[]
  current_store_id: string | null
}

function requireUser(): User {
  const user = firebaseAuth.currentUser
  if (!user) throw new Error('Sesi Firebase belum aktif. Silakan masuk kembali.')
  return user
}

async function tokenOf(user: User): Promise<string> {
  return getIdToken(user, true)
}

function userShape(user: User, currentStoreId: string | null): AccountUser {
  return {
    id: user.uid,
    name: user.displayName || user.email?.split('@')[0] || 'Kasir',
    email: user.email || '',
    avatar_url: user.photoURL,
    current_store_id: currentStoreId,
  }
}

async function payloadFor(user: User): Promise<AuthPayload> {
  const profile = await getDoc(profileRef(user.uid))
  const data = profile.data() as Partial<ProfileData> | undefined
  const stores = Array.isArray(data?.stores) ? data.stores : []
  const currentStoreId = data?.current_store_id || stores[0]?.id || null
  return { token: await tokenOf(user), user: userShape(user, currentStoreId == null ? null : String(currentStoreId)), stores }
}

export class FirebaseApiClient {
  async loginEmail(email: string, password: string): Promise<AuthPayload> {
    const credential = await signInWithEmailAndPassword(firebaseAuth, email, password)
    return payloadFor(credential.user)
  }

  async registerEmail(name: string, email: string, password: string): Promise<AuthPayload> {
    const credential = await createUserWithEmailAndPassword(firebaseAuth, email, password)
    const storeId = crypto.randomUUID()
    const store: AccountStore = { id: storeId, name: name.trim() || 'Shakala Bakery', role: 'owner' }
    await setDoc(storeRef(storeId), {
      name: store.name,
      owner_id: credential.user.uid,
      created_at: Date.now(),
    })
    await setDoc(memberRef(storeId, credential.user.uid), { role: 'owner', uid: credential.user.uid })
    await setDoc(profileRef(credential.user.uid), {
      name: name.trim() || 'Kasir',
      email,
      stores: [store],
      current_store_id: storeId,
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
    await setDoc(storeRef(String(store.id)), { name: store.name, owner_id: user.uid, created_at: Date.now() })
    await setDoc(memberRef(String(store.id), user.uid), { role: 'owner', uid: user.uid })
    const stores = [...profile.stores, store]
    await updateDoc(profileRef(user.uid), { stores, current_store_id: String(store.id) })
    return { store, stores }
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
