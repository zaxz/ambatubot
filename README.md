# WhatsApp Bot: Otomatisasi Pesan & Pembuat Stiker

Bot WhatsApp modern dan handal yang dibangun menggunakan library [@whiskeysockets/baileys](https://github.com/whiskeysockets/Baileys). Bot ini dirancang khusus untuk kebutuhan **otomatisasi pesan (auto-responder, FAQ, broadcast siaran)** dan **pembuatan stiker WhatsApp (gambar, video/GIF bergerak, serta custom metadata EXIF)**.

---

## 🚀 Fitur Utama

### 1. 🎨 Pembuat Stiker WhatsApp (Sticker Maker)
* **Gambar ke Stiker**: Mengubah foto/gambar menjadi stiker WebP 512x512 secara proporsional tanpa distorsi (menggunakan padding transparan).
* **Video/GIF ke Stiker Bergerak (Animated Sticker)**: Mengubah video pendek atau GIF (maksimal 9 detik) menjadi stiker animasi WhatsApp.
* **Custom EXIF Metadata**: Mendukung kustomisasi *Pack Name* (nama paket) dan *Author* (nama pembuat) saat stiker diklik di WhatsApp.
* **Stiker ke Gambar (`.toimg`)**: Mengubah stiker kembali menjadi file foto/gambar PNG.

### 2. ⚡ Otomatisasi Pesan & Auto-Responder
* **Pencocokan Kata Kunci Fleksibel**:
  * `exact`: Respon otomatis jika teks sama persis (misal: "halo", "ping", "assalamualaikum").
  * `contains`: Respon otomatis jika pesan memuat kata kunci (misal: "jam buka", "harga", "rekening", "lokasi", "admin").
  * `regex`: Pola ekspresi reguler untuk kebutuhan pencocokan tingkat lanjut.
* **Variabel Dinamis**: Mendukung placeholder otomatis seperti `{name}` (nama pengirim), `{time}` (jam saat ini), dan `{date}` (tanggal hari ini).
* **Anti-Spam Cooldown**: Mencegah bot membalas berulang kali dalam jeda waktu singkat jika pengirim melakukan spam pesan serupa.
* **Simulasi Mengetik (*Typing Presence*)**: Menampilkan status "sedang mengetik..." sebelum membalas agar terlihat natural layaknya manusia.

### 3. 📢 Broadcast Otomatis Aman (Anti-Ban Jitter)
* Mengirimkan pesan siaran secara massal ke daftar nomor atau grup.
* Dilengkapi jeda acak (*random delay jitter*, default 2–4 detik antar pesan) untuk mematuhi ritme pengiriman dan meminimalisir risiko blokir dari WhatsApp.

### 6. 🤖 Balasan AI dengan Personalisasi (Mention)
* **Pemicu**: Balasan AI aktif ketika bot disebut (*mention*) di grup, atau ketika seseorang membalas pesan milik bot sendiri.
* **Personalisasi**: AI memanggil nama pengirim dan menyertakan konteks grup (nama grup) dalam prompt, sehingga balasan terasa natural dan relevan.
* **Provider**: Google Gemini (`gemini-1.5-flash`) melalui REST + `axios` — tidak perlu menginstal paket tambahan.
* **Pengendalian**: Aktif/nonaktif lewat `config.ai.enabled`, batasi hanya grup lewat `mentionOnlyInGroup`, dan jeda per chat lewat `cooldownMs` (default 10 detik) agar tidak spam.
* **Kegagalan**: Jika AI sedang gangguan atau kuota habis, bot membalas *"Maaf, AI sedang gangguan. Coba lagi nanti."* sekali dan tetap online.

### 4. 🔑 Login Pairing Code
* Bot terhubung via **Pairing Code (8 Digit)** — cocok untuk VPS Linux/Cloud server tanpa perlu memindai kamera ponsel.

### 5. 💾 Multi-File Auth State
* Sesi login tersimpan secara lokal di folder `./session`. Bot akan otomatis terhubung kembali saat server di-restart tanpa perlu scan ulang.

---

## 📋 Prasyarat Sistem

1. **Node.js**: Versi `18.x` atau `20.x` LTS ke atas.
2. **FFmpeg**: Wajib terpasang di sistem operasi server/komputer untuk memproses konversi video dan gambar.

### Cara Cek / Pasang FFmpeg:
* **Ubuntu / Debian VPS:**
  ```bash
  sudo apt update
  sudo apt install -y ffmpeg
  ```
* **macOS (Homebrew):**
  ```bash
  brew install ffmpeg
  ```
* **Windows:**
  Unduh binary FFmpeg dari [ffmpeg.org](https://ffmpeg.org/download.html) dan tambahkan path ke *Environment Variables (System PATH)*.

---

## 🛠️ Panduan Instalasi & Menjalankan

### 1. Ekstrak / Clone Proyek
Masuk ke direktori proyek:
```bash
cd whatsapp-bot
```

### 2. Install Dependencies
Jalankan perintah berikut untuk mengunduh semua modul yang dibutuhkan:
```bash
npm install
```

### 3. Konfigurasi Environment (`.env`)
Salin file `.env.example` menjadi `.env`, lalu isi kredensial Anda:
```bash
cp .env.example .env
```
Isi variabel di `.env`:
* `GEMINI_API_KEY`: Kunci API Google Gemini (dapatkan gratis di [Google AI Studio](https://aistudio.google.com/)).
* `OWNER_NUMBER`: Nomor WhatsApp pemilik bot (contoh: `6281234567890` tanpa tanda `+`).
* `PAIRING_NUMBER`: Nomor WhatsApp yang digunakan untuk login pairing code bot.

> 🔒 *File `.env` dan folder `./session` sudah otomatis dilindungi oleh `.gitignore` sehingga kredensial Anda aman dan tidak akan ter-upload ke GitHub.*
### 4. Menjalankan Bot
Jalankan bot dengan perintah:
```bash
npm start
```
* Buka WhatsApp di ponsel > *Perangkat Tertaut* > *Tautkan Perangkat* > *Tautkan dengan nomor telepon saja*, lalu masukkan kode 8 digit yang muncul di terminal.

---

## 📖 Daftar Perintah Bot

| Perintah | Deskripsi | Contoh Penggunaan |
| :--- | :--- | :--- |
| `.menu` / `.help` | Menampilkan daftar perintah dan status bot | Kirim `.menu` |
| `.s` / `.sticker` | Mengubah gambar/video menjadi stiker WhatsApp | Kirim gambar dengan caption `.s` atau reply gambar dengan `.s` |
| `.smeme <atas> \| <bawah>` | Membuat stiker meme dengan teks atas dan bawah | Kirim gambar dengan caption `.smeme KETIKA CODING \| TIBA-TIBA ERROR` |
| `.brat <teks>` | Membuat stiker teks brat putih tren meme | Kirim `.brat sok iye loe jadi orang` |
| `.toimg` | Mengubah stiker menjadi file gambar (PNG) | Reply sebuah stiker dengan `.toimg` |
| `.jadwal <kelas> [hari]` | Cek jadwal kuliah IWIMA (hari ini, besok, lusa, semua) | Kirim `.jadwal 3p51 hari ini` atau `.jadwal 3p51 besok` |
| `.pj <kelas> <matkul>` | Cek Penanggung Jawab (PJ) matkul & kontak WA dosen | Kirim `.pj 3p51 statistik` atau `.pj 3p51 semua` |
| `.ping` | Mengecek kecepatan respon bot (latensi server) | Kirim `.ping` |
| `.runtime` | Menampilkan durasi aktif bot dan penggunaan RAM | Kirim `.runtime` |
| `.bc <teks>` | Mengirim pesan siaran (Khusus Owner) | Kirim `.bc Promo Spesial Hari Ini!` |

---

## ⚡ Menambah Fitur Baru di `src/case.js`

Seluruh perintah bot dipisahkan ke dalam file **`src/case.js`** agar mudah diubah atau ditambah.

Untuk menambah fitur baru, cukup buka **`src/case.js`** lalu tambahkan blok `case` baru:
```javascript
case "halo": {
  await reply(`Halo kak ${pushName}! Ada yang bisa saya bantu?`);
  break;
}
```
---

## ⚙️ Menambahkan Auto-Reply Baru

Untuk menambahkan respon otomatis baru, buka file `config.js` pada bagian `autoReply.rules`:

```javascript
{
  type: 'contains', // atau 'exact'
  keywords: ['garansi', 'retur', 'klaim'],
  response: 'Halo {name}, untuk klaim garansi produk silakan siapkan nomor resi pengiriman dan video unboxing paket Anda.'
}
```

---

## 🛡️ Tips Keamanan Agar Nomor Tidak Terblokir (Anti-Ban)

WhatsApp memiliki algoritma deteksi perilaku bot dan spam yang ketat. Ikuti panduan berikut agar nomor Anda tetap aman:
1. **Gunakan Nomor yang Sudah Berumur**: Hindari menggunakan nomor baru yang belum pernah aktif. Sebaiknya gunakan nomor yang sudah sering digunakan untuk percakapan normal.
2. **Jangan Mengirim Broadcast Terlalu Agresif**: Jangan mengirim pesan ke ratusan nomor dalam hitungan detik. Pertahankan fitur jeda (`delayMinMs` dan `delayMaxMs` di `config.js`).
3. **Targetkan Kontak yang Menyimpan Nomor Anda**: Pesan yang dikirim ke orang asing yang tidak menyimpan nomor Anda rentan dilaporkan (*Report as Spam/Block*).
4. **Berikan Opsi Berhenti (*Opt-out*)**: Jika membuat bot bisnis/broadcast, sertakan teks seperti *"Ketik STOP untuk berhenti menerima pesan"*.
