require('dotenv').config({ quiet: true });

/**
 * Konfigurasi Utama WhatsApp Bot Baileys
 */
module.exports = {
  // Informasi Dasar Bot
  botName: 'AmbatuBOT',
  botPrefix: '.',
  
  // Informasi Pemilik (Owner) Bot
  ownerName: 'callmejeki',
  ownerNumbers: process.env.OWNER_NUMBER ? [process.env.OWNER_NUMBER] : ['6282214456775'],

  // Login via Pairing Code 8 digit (QR Code dihapus karena sudah tidak didukung library)
  pairingNumber: process.env.PAIRING_NUMBER || '6285217096317', // Nomor WhatsApp yang akan dipairing

  // Konfigurasi Default Metadata Stiker WhatsApp
  sticker: {
    packName: 'AmbatuBOT',
    packAuthor: 'callmejeki🥀',
    maxVideoDurationSeconds: 9, // Maksimal durasi video/gif untuk stiker bergerak (detik)
    maxSizeBytes: 1024 * 1024 // 1 MB batas wajar stiker WhatsApp
  },

  // Konfigurasi Otomatisasi Pesan & Auto-Responder
  autoReply: {
    enabled: true,
    // Mengabaikan pesan dari grup jika hanya ingin auto-reply di chat pribadi
    privateOnly: false,
    
    // Pesan sapaan pembuka jika keyword cocok
    rules: [
      {
        type: 'exact', // Cocok persis
        keywords: ['halo', 'hai', 'hello', 'hi', 'p', 'ping'],
        response: 'Halo kak {name}! 👋 Ada yang bisa saya bantu?\n\nKetik *.menu* untuk melihat daftar perintah bot, atau kirim gambar dengan caption *.s* untuk membuat stiker.'
      },
      {
        type: 'exact',
        keywords: ['assalamualaikum', 'assalamu\'alaikum'],
        response: 'Wa\'alaikumussalam Warahmatullahi Wabarakatuh kak {name}. 🙏 Ada yang bisa kami bantu hari ini?'
      },
      {
        type: 'contains', // Mengandung kata kunci berikut
        keywords: ['jam buka', 'jam operasional', 'jam kerja'],
        response: '⏰ *Jam Operasional Layanan:*\n• Senin - Jumat: 08.00 - 17.00 WIB\n• Sabtu: 09.00 - 15.00 WIB\n• Minggu & Hari Libur Nasional: Tutup\n\nPesan di luar jam kerja akan dibalas pada hari kerja berikutnya.'
      }
    ]
  },

  // Konfigurasi tanda baca (centang biru) untuk pesan masuk
  readReceipt: {
    enabled: true,
    allMessages: true, // true: semua pesan masuk langsung ditandai dibaca (termasuk obrolan grup)
    groups: true, // tandai pesan yang masuk di grup
    privateChat: true // tandai pesan yang masuk di chat pribadi
  },

  // Konfigurasi limit chat harian per pengguna (reset otomatis pukul 00.00 WIB)
  chatLimit: {
    enabled: true,
    defaultLimit: 20, // kuota chat default per hari untuk non-owner
    countAutoReply: true, // pesan auto-reply (FAQ) juga dihitung sebagai chat
    noticeCooldownMs: 60000 // jeda minimal antar peringatan "limit habis" per user
  },

  // Konfigurasi AI (Google Gemini) untuk balasan mention dengan personalisasi
  ai: {
    enabled: true,
    provider: 'google',
    model: process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite',
    apiKey: process.env.GEMINI_API_KEY || '', // Diambil dari file .env
    temperature: 0.4,
    maxOutputTokens: 1500,
    mentionOnlyInGroup: false, // true: AI hanya aktif saat disebut di grup; false: AI juga balas DM
    cooldownMs: 3000, // jeda AI per pengirim untuk mencegah spam (milidetik)
  }
};
