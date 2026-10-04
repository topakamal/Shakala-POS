import { getApp, getApps, initializeApp } from 'firebase/app'
import { getAuth } from 'firebase/auth'
import { getFirestore } from 'firebase/firestore'

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || 'AIzaSyBrocEcOCcq_k0EuAf_PFNX32G66D_qbeg',
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || 'shakala-pos.firebaseapp.com',
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || 'shakala-pos',
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || 'shakala-pos.firebasestorage.app',
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || '450524089575',
  appId: import.meta.env.VITE_FIREBASE_APP_ID || '1:450524089575:web:b42f855de3060497ef6642',
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID || 'G-55N7ZLG24G',
}

export const firebaseApp = getApps().length ? getApp() : initializeApp(firebaseConfig)
export const firebaseAuth = getAuth(firebaseApp)
export const firebaseDb = getFirestore(firebaseApp)
export { firebaseConfig }
