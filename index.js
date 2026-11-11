require('dotenv').config({ quiet: true });
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

const lockFile = path.join(sessionDir, '.bot.lock');

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function logDuplicateAlert(headline, hint) {
  const redBold = '\x1b[31m\x1b[1m';
  const yellow = '\x1b[33m';
  const reset = '\x1b[0m';
  console.warn(`${redBold}🚨 [ALERT PROSES GANDA] ${headline}${reset}`);
  console.warn(`${yellow}   ${hint}${reset}`);
}

function checkAndAcquireLock() {
  try {
    if (fs.existsSync(lockFile)) {
      const prevPid = Number(fs.readFileSync(lockFile, 'utf8').trim());
      if (prevPid && prevPid !== process.pid && isPidAlive(prevPid)) {
        logDuplicateAlert(
          `Proses bot lain masih aktif di mesin ini (PID: ${prevPid})!`,
          'Menjalankan >1 proses dengan sesi yang sama akan memicu Status 440 (conflict). Matikan salah satu terminal/proses.'
        );
      }
    }
    fs.writeFileSync(lockFile, String(process.pid), 'utf8');
  } catch (err) {
    // Abaikan error lockfile agar bot tetap bisa berjalan
  }
}

function releaseLock() {
  try {
    if (fs.existsSync(lockFile) && fs.readFileSync(lockFile, 'utf8').trim() === String(process.pid)) {
      fs.unlinkSync(lockFile);
    }
  } catch (err) {
    // Abaikan error hapus lockfile
  }
}
/**
 * Inisialisasi dan menghubungkan bot WhatsApp menggunakan Whiskeysockets Baileys
 */
const MAX_CACHED_MESSAGES = 500;
const GROUP_META_TTL_MS = 60 * 1000;

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

  // Cache pesan terkirim/masuk agar Baileys bisa merespon retry request enkripsi (mencegah pesan macet "mengetik...")
  const msgStore = new Map();
  const rememberMessage = (id, message) => {
    if (!id || !message) return;
    if (!msgStore.has(id) && msgStore.size >= MAX_CACHED_MESSAGES) {
      const oldest = msgStore.keys().next().value;
      if (oldest) msgStore.delete(oldest);
    }
    msgStore.set(id, message);
  };

  const groupMetaCache = new Map();
  const getCachedGroupMeta = (jid) => {
    const entry = groupMetaCache.get(jid);
    if (!entry) return undefined;
    if (Date.now() - entry.ts > GROUP_META_TTL_MS) {
      groupMetaCache.delete(jid);
      return undefined;
    }
    return entry.data;
  };

  // Buat socket koneksi Baileys
  const sock = makeWASocket({
    version,
    logger: pino({ level: 'error' }),
    auth: state,
    browser: Browsers.ubuntu('Chrome'),
    syncFullHistory: false,
    generateHighQualityLinkPreview: true,
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 25000,
    getMessage: async (key) => (key?.id ? msgStore.get(key.id) : undefined),
    cachedGroupMetadata: async (jid) => getCachedGroupMeta(jid),
  });

  // Simpan setiap pesan keluar seketika agar langsung tersedia bila penerima mengirim retry receipt
  const origSendMessage = sock.sendMessage.bind(sock);
  sock.sendMessage = async (jid, content, options = {}) => {
    const fullMsg = await origSendMessage(jid, content, options);
    if (fullMsg?.key?.id && fullMsg?.message) {
      rememberMessage(fullMsg.key.id, fullMsg.message);
    }
    return fullMsg;
  };

  const origGroupMetadata = sock.groupMetadata.bind(sock);
  sock.groupMetadata = async (jid) => {
    const cached = getCachedGroupMeta(jid);
    if (cached) return cached;
    const fresh = await origGroupMetadata(jid);
    if (fresh) {
      groupMetaCache.set(jid, { data: fresh, ts: Date.now() });
    }
    return fresh;
  };
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

      if (statusCode === DisconnectReason.connectionReplaced) {
        logDuplicateAlert(
          'Sesi WhatsApp ini terputus karena konflik koneksi (Status 440)!',
          'Ada instance bot lain yang aktif memakai sesi yang sama (mis. bot di server + lokal bersamaan, atau terminal ganda). Matikan salah satu instance.'
        );
      }

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

  // Invalidasi cache metadata grup bila ada perubahan anggota/info grup
  sock.ev.on('groups.update', (updates) => {
    for (const u of updates) {
      if (u?.id) groupMetaCache.delete(u.id);
    }
  });
  sock.ev.on('group-participants.update', ({ id }) => {
    if (id) groupMetaCache.delete(id);
  });

  // Laporkan jika WhatsApp server menolak pesan yang dikirim bot
  sock.ev.on('messages.update', (updates) => {
    for (const { key, update } of updates) {
      if (update?.status === 0 && key?.fromMe) {
        console.warn(`[WA] Pengiriman pesan gagal/ditolak (${key.remoteJid}):`, update.messageStubParameters || 'error ack');
      }
    }
  });

  // Event Pesan Masuk
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    for (const msg of messages) {
      if (msg?.key?.id && msg?.message) {
        rememberMessage(msg.key.id, msg.message);
      }
    }

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
process.on('exit', releaseLock);
process.on('SIGINT', () => {
  console.log('\nMematikan bot secara aman...');
  releaseLock();
  process.exit(0);
});
process.on('SIGTERM', () => {
  releaseLock();
  process.exit(0);
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled Rejection terdeteksi:', err);
});

// Cek apakah ada proses bot ganda sebelum memulai koneksi
checkAndAcquireLock();

// Jalankan bot
startBot();
