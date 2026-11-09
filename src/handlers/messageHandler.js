const { getContentType, jidNormalizedUser } = require("@whiskeysockets/baileys");
const config = require("../../config");
const { checkAutoReply } = require("./autoReplyHandler");
const { generateReply } = require("../utils/aiClient");
const handleCase = require("../case");

const startTime = Date.now();
// Memory cache untuk rate-limiting AI per chat (agar tidak spam jika disebut berulang)
const aiCooldownMap = new Map();

/**
 * Format durasi waktu ke teks terbaca (jam, menit, detik)
 * @param {number} ms
 */
function formatUptime(ms) {
	const seconds = Math.floor((ms / 1000) % 60);
	const minutes = Math.floor((ms / (1000 * 60)) % 60);
	const hours = Math.floor((ms / (1000 * 60 * 60)) % 24);
	const days = Math.floor(ms / (1000 * 60 * 60 * 24));

	const parts = [];
	if (days > 0) parts.push(`${days} hari`);
	if (hours > 0) parts.push(`${hours} jam`);
	if (minutes > 0) parts.push(`${minutes} menit`);
	parts.push(`${seconds} detik`);
	return parts.join(" ");
}

/**
 * Handler utama untuk seluruh pesan masuk Baileys
 * @param {Object} sock - Instance Baileys WASocket
 * @param {Object} m - Objek pesan dari Baileys messages.upsert
 */
async function handleMessage(sock, m) {
	try {
		const from = m.key.remoteJid;
		const isGroup = from.endsWith("@g.us");
		const sender = isGroup ? m.key.participant : from;
		const pushName = m.pushName || "Sahabat";

		// Normalisasi nomor pengirim untuk pengecekan status owner
		const cleanSender = sender.replace(/[^0-9]/g, "");
		const isOwner = config.ownerNumbers.some((num) => num.replace(/[^0-9]/g, "") === cleanSender);

		// Ekstraksi pesan aktual (antisipasi ephemeral & viewOnce wrapper)
		let msg = m.message;
		if (msg.ephemeralMessage) msg = msg.ephemeralMessage.message;
		if (msg.viewOnceMessageV2) msg = msg.viewOnceMessageV2.message;
		else if (msg.viewOnceMessage) msg = msg.viewOnceMessage.message;

		const messageType = getContentType(msg) || Object.keys(msg)[0];

		// Ekstraksi teks isi pesan
		let body = "";
		if (messageType === "conversation") {
			body = msg.conversation;
		} else if (messageType === "extendedTextMessage") {
			body = msg.extendedTextMessage?.text || "";
		} else if (messageType === "imageMessage") {
			body = msg.imageMessage?.caption || "";
		} else if (messageType === "videoMessage") {
			body = msg.videoMessage?.caption || "";
		}

		const trimmedBody = body.trim();
		const prefix = config.botPrefix;
		const isCommand = trimmedBody.startsWith(prefix);


		// Logging pesan masuk & command prefix
		const chatLabel = isGroup ? `GRUP(${from})` : `PRIV(${from})`;
		const preview = trimmedBody.length > 60 ? trimmedBody.slice(0, 60) + "…" : trimmedBody;
		console.log(`[MSG] ${chatLabel} | ${pushName} (${sender}): "${preview}"`);

		if (isCommand) {
			console.log(`[CMD] ${chatLabel} | ${pushName}: ${trimmedBody}`);
		}


		// Deteksi konteks pesan kutipan (reply/quote)
		const contextInfo = msg[messageType]?.contextInfo;
		const quotedMsg = contextInfo?.quotedMessage;
		const quotedType = quotedMsg ? Object.keys(quotedMsg)[0] : null;

		// Helper untuk membalas pesan dengan quote otomatis
		const reply = async (text) => {
			await sock.sendMessage(from, { text }, { quoted: m });
		};

		// =========================================================================
		// 1. ROUTING COMMAND (JIKA DIAWALI PREFIX MISAL '.')
		// =========================================================================
		if (isCommand) {
			const args = trimmedBody.slice(prefix.length).trim().split(/ +/);
			const command = args[0].toLowerCase();
			const text = args.slice(1).join(" ");

			await handleCase({
				sock,
				m,
				command,
				args,
				text,
				prefix,
				from,
				isGroup,
				sender,
				pushName,
				isOwner,
				msg,
				messageType,
				contextInfo,
				quotedMsg,
				quotedType,
				reply,
				startTime,
			});
			return;
		}
		// =========================================================================
		// 1.5. AI BALASAN SERTAMAN (MENTION / BALAS KE PESAN BOT)
		// =========================================================================
		const botJid = sock.user?.id ? jidNormalizedUser(sock.user.id) : null;
		const botLid = sock.user?.lid ? jidNormalizedUser(sock.user.lid) : null;
		const botNumber = botJid
			? botJid.replace(/[^0-9]/g, "")
			: (config.pairingNumber || "").replace(/[^0-9]/g, "");

		const mentionedJids = (contextInfo?.mentionedJid || []).map((j) => jidNormalizedUser(j));
		const isMentioned =
			Boolean(botJid && mentionedJids.includes(botJid)) ||
			Boolean(botLid && mentionedJids.includes(botLid)) ||
			Boolean(botNumber && trimmedBody.includes("@" + botNumber)) ||
			Boolean(config.botName && trimmedBody.toLowerCase().includes("@" + config.botName.toLowerCase()));

		const quotedParticipant = contextInfo?.participant ? jidNormalizedUser(contextInfo.participant) : null;
		const isReplyingToBot =
			Boolean(botJid && quotedParticipant === botJid) ||
			Boolean(botLid && quotedParticipant === botLid) ||
			contextInfo?.quotedMessage?.fromMe === true;

		if (
			!isCommand &&
			trimmedBody &&
			config.ai.enabled &&
			(isMentioned || isReplyingToBot) &&
			!(config.ai.mentionOnlyInGroup && !isGroup)
		) {
			const cooldownKey = sender || from;
			const now = Date.now();
			const lastAi = aiCooldownMap.get(cooldownKey) || 0;
			if (now - lastAi >= config.ai.cooldownMs) {
				aiCooldownMap.set(cooldownKey, now);

				console.log(`[AI] Mention/Reply terdeteksi dari ${pushName} (${chatLabel}): "${trimmedBody}"`);

				// Indikator 'sedang mengetik...' (best-effort, tidak blokir balasan)
				try {
					await sock.sendPresenceUpdate("composing", from);
				} catch (e) {
					// Abaikan gagal presence
				}


				// Bersihkan tag @bot (nomor HP, LID, atau nama bot) agar prompt ke AI bersih
				let cleanMessage = trimmedBody;
				const botLidNumber = botLid ? botLid.replace(/[^0-9]/g, "") : null;
				if (botNumber) {
					cleanMessage = cleanMessage.replace(new RegExp(`@${botNumber}`, "g"), "");
				}
				if (botLidNumber) {
					cleanMessage = cleanMessage.replace(new RegExp(`@${botLidNumber}`, "g"), "");
				}
				if (config.botName) {
					cleanMessage = cleanMessage.replace(new RegExp(`@${config.botName}`, "gi"), "");
				}
				cleanMessage = cleanMessage.replace(/@\d+/g, "").trim() || trimmedBody;

				try {
					const aiReply = await generateReply({
						message: cleanMessage,
						botName: config.botName,
						config,
					});
					await sock.sendMessage(from, { text: aiReply }, { quoted: m });
					console.log(`[AI] Berhasil membalas ${pushName}: "${aiReply.slice(0, 60)}..."`);
				} catch (err) {
					console.error("[AI] Error generateReply AI:", err.message);
					await reply("Maaf, AI sedang gangguan. Coba lagi nanti.");
				}
			}
			return;
		}

		// =========================================================================
		// 2. OTOMATISASI PESAN / AUTO-RESPONDER NON-COMMAND (FAQ & KEYWORDS)
		// =========================================================================
		if (!isCommand && trimmedBody) {
			if (config.autoReply.privateOnly && isGroup) {
				return; // Jangan respon di grup jika disetel khusus chat pribadi
			}

			const autoReplyText = checkAutoReply(trimmedBody, sender, pushName);
			if (autoReplyText) {
				// Berikan indikator visual 'sedang mengetik...' sejenak agar terlihat natural
				await sock.sendPresenceUpdate("composing", from);
				setTimeout(async () => {
					await sock.sendPresenceUpdate("paused", from);
					await reply(autoReplyText);
				}, 800);
			}
		}
	} catch (error) {
		console.error("Terjadi kesalahan pada handleMessage:", error);
	}
}

module.exports = {
	handleMessage,
};
