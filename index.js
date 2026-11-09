require('dotenv').config();
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

const config = require('./config');
const { handleMessage } = require('./src/handlers/messageHandler');

// Pastikan direktori sesi ada
const sessionDir = path.join(__dirname, 'session');
if (!fs.existsSync(sessionDir)) {
  fs.mkdirSync(sessionDir, { recursive: true });
}

/**
 * Inisialisasi dan menghubungkan bot WhatsApp menggunakan Whiskeysockets Baileys
 */
async function startBot() {
  console.log('\n======================================================');
  console.log(`🚀 Memulai ${config.botName}...`);
  console.log('Library: @whiskeysockets/baileys');
  console.log('======================================================\n');

  // Ambil versi Baileys terbaru dari server WhatsApp
  const { version, isLatest } = await fetchLatestBaileysVersion().catch(() => ({
    version: [2, 3000, 1015901307],
    isLatest: false
  }));
  console.log(`Menggunakan WA Web versi: v${version.join('.')}`);

  // Manajemen otentikasi multi-file (session tersimpan di folder ./session)
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

  // Buat socket koneksi Baileys
  const sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }), // Ganti ke 'info' jika ingin melihat raw network logs
    auth: state,
    browser: Browsers.ubuntu('Chrome'),
    syncFullHistory: false,
    generateHighQualityLinkPreview: true,
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 25000
  });

  // Login via Pairing Code (diajukan otomatis saat sesi belum terdaftar)
  if (!sock.authState.creds.registered) {
    const cleanNumber = config.pairingNumber.replace(/[^0-9]/g, '');
    console.log(`Menyiapkan permintaan Pairing Code untuk nomor: ${cleanNumber}`);

    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(cleanNumber);
        console.log('\n┌──────────────────────────────────────────────┐');
        console.log(`│ 🔑 KODE PAIRING WHATSAPP: ${code.match(/.{1,4}/g)?.join('-') || code}    │`);
        console.log('├──────────────────────────────────────────────┤');
        console.log('│ 1. Buka WhatsApp di HP Anda                  │');
        console.log('│ 2. Klik Titik Tiga > Perangkat Tertaut       │');
        console.log('│ 3. Klik "Tautkan Perangkat"                  │');
        console.log('│ 4. Pilih "Tautkan dengan nomor telepon saja" │');
        console.log('│ 5. Masukkan kode 8 digit di atas!            │');
        console.log('└──────────────────────────────────────────────┘\n');
      } catch (err) {
        console.error('Gagal meminta pairing code:', err.message);
      }
    }, 4000);
  }

  // Event Update Status Koneksi
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output?.statusCode
        : lastDisconnect?.error?.statusCode;

      const reason = lastDisconnect?.error?.message || statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.log(`⚠️ Koneksi terputus. Alasan: ${reason} (Status: ${statusCode})`);

      if (shouldReconnect) {
        console.log('🔄 Mencoba menghubungkan ulang ke WhatsApp dalam 5 detik...');
        setTimeout(() => startBot(), 5000);
      } else {
        console.log('❌ Anda telah Logout dari sesi WhatsApp.');
        console.log('Silakan hapus folder ./session lalu jalankan bot kembali untuk login ulang.');
      }
    } else if (connection === 'open') {
      const botNumber = sock.user?.id ? sock.user.id.split(':')[0] : 'Unknown';
      console.log('\n======================================================');
      console.log('✅ BOT WHATSAPP BERHASIL TERHUBUNG!');
      console.log(`Nomor Bot   : ${botNumber}`);
      console.log(`Nama Akun   : ${sock.user?.name || config.botName}`);
      console.log(`Prefix Aktif: ${config.botPrefix}`);
      console.log('======================================================');
      console.log('Bot siap melayani pembuatan stiker dan otomatisasi pesan!\n');
    }
  });

  // Event Simpan Kredensial Sesi Otomatis
  sock.ev.on('creds.update', saveCreds);

  // Event Pesan Masuk
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      // Abaikan jika pesan kosong atau pesan status/cerita (broadcast/status@broadcast)
      if (!msg.message || msg.key.remoteJid === 'status@broadcast') continue;

      // Abaikan pesan yang dikirim oleh bot sendiri
      if (msg.key.fromMe) continue;

      // Proses pesan di handler terpisah
      await handleMessage(sock, msg);
    }
  });

  return sock;
}

// Tangani penutupan proses secara graceful
process.on('SIGINT', () => {
  console.log('\nMematikan bot secara aman...');
  process.exit(0);
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled Rejection terdeteksi:', err);
});

// Jalankan bot
startBot();
