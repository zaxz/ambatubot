const config = require('../../config');

// Memory cache untuk rate-limiting auto-reply per kontak (agar tidak spam jika user mengirim chat berulang)
const cooldownMap = new Map();
const COOLDOWN_MS = 5000; // 5 detik jeda per kontak untuk pesan serupa

/**
 * Memeriksa apakah pesan cocok dengan salah satu aturan auto-reply
 * @param {string} text - Teks pesan masuk
 * @param {string} senderJid - JID pengirim
 * @param {string} senderName - Nama pengirim
 * @returns {string|null} - Teks balasan atau null jika tidak cocok
 */
function checkAutoReply(text, senderJid, senderName = 'Kak') {
  if (!config.autoReply.enabled || !text) return null;

  const cleanText = text.trim().toLowerCase();
  const now = Date.now();

  // Cek cooldown per kontak
  const lastReplied = cooldownMap.get(senderJid) || 0;
  if (now - lastReplied < COOLDOWN_MS) {
    return null;
  }

  for (const rule of config.autoReply.rules) {
    let matched = false;

    if (rule.type === 'exact') {
      matched = rule.keywords.some((kw) => cleanText === kw.toLowerCase());
    } else if (rule.type === 'contains') {
      matched = rule.keywords.some((kw) => cleanText.includes(kw.toLowerCase()));
    } else if (rule.type === 'regex' && rule.pattern) {
      matched = new RegExp(rule.pattern, 'i').test(cleanText);
    }

    if (matched) {
      cooldownMap.set(senderJid, now);

      // Format variabel dinamis
      const currentTime = new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
      const currentDate = new Date().toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

      let formattedResponse = rule.response
        .replace(/{name}/g, senderName || 'Kak')
        .replace(/{time}/g, currentTime)
        .replace(/{date}/g, currentDate);

      return formattedResponse;
    }
  }

  return null;
}

module.exports = {
  checkAutoReply
};
