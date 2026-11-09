const config = require('../../config');

/**
 * Menunggu jeda waktu (sleep) dalam milidetik
 * @param {number} ms
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Mengirim pesan broadcast ke daftar nomor/grup dengan jeda acak aman
 * @param {Object} sock - Instance Baileys WASocket
 * @param {Array<string>} targetList - Daftar JID tujuan (misal: ['6281234567890@s.whatsapp.net', '...'])
 * @param {Object} messageContent - Konten pesan Baileys ({ text: '...' } atau { image: buffer, caption: '...' })
 * @param {Function} onProgress - Callback progres status
 * @returns {Promise<{success: number, failed: number, errors: Array}>}
 */
async function sendBroadcast(sock, targetList, messageContent, onProgress = () => {}) {
  let success = 0;
  let failed = 0;
  const errors = [];

  const { delayMinMs, delayMaxMs } = config.broadcast;

  for (let i = 0; i < targetList.length; i++) {
    const rawTarget = targetList[i].trim();
    if (!rawTarget) continue;

    // Normalisasi format JID WhatsApp
    let jid = rawTarget;
    if (!jid.includes('@')) {
      const cleanNumber = jid.replace(/[^0-9]/g, '');
      jid = `${cleanNumber}@s.whatsapp.net`;
    }

    try {
      await sock.sendMessage(jid, messageContent);
      success++;
      onProgress({ current: i + 1, total: targetList.length, jid, status: 'success' });
    } catch (err) {
      failed++;
      errors.push({ jid, error: err.message });
      onProgress({ current: i + 1, total: targetList.length, jid, status: 'failed', error: err.message });
    }

    // Berikan jeda acak di antara pengiriman pesan (kecuali di pesan terakhir)
    if (i < targetList.length - 1) {
      const randomDelay = Math.floor(Math.random() * (delayMaxMs - delayMinMs + 1)) + delayMinMs;
      await sleep(randomDelay);
    }
  }

  return { success, failed, errors };
}

module.exports = {
  sendBroadcast
};
