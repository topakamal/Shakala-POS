# Firebase Shakala POS

Project ini memakai Firebase project `shakala-pos` sebagai backend default.
`VITE_BACKEND=laravel` masih tersedia hanya untuk kompatibilitas lama.

## Aktifkan layanan

Di Firebase Console project `shakala-pos`:

1. Authentication → Sign-in method → aktifkan Email/Password.
2. Firestore Database → Create database.
3. Firestore Rules → gunakan isi `firestore.rules` dari repository ini.
4. Hosting → buat site dengan Site ID `shakala-bakery`.

## Jalankan lokal

```bash
npm ci
npm run build
```

## Deploy Hosting

Firebase CLI harus dijalankan dari root project:

```bash
npm install -g firebase-tools
firebase login
firebase deploy --only hosting,firestore
```

Data bisnis Android tetap disimpan di SQLite saat offline. Setelah akun Firebase
masuk dan toko aktif, outbox lokal dikirim ke Firestore dan perubahan dari web
ditarik kembali sesuai `updated_at`.
