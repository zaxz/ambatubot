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

// Kode warna ANSI standar untuk tampilan log konsol yang bersih dan berwarna
const color = {
	reset: "\x1b[0m",
	dim: "\x1b[90m",
	bold: "\x1b[1m",
	cyan: "\x1b[36m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	magenta: "\x1b[35m",
	blue: "\x1b[34m",
};

// Cache nama grup agar tidak berulang kali memanggil network request ke WhatsApp
const groupNameCache = new Map();

/**
 * Format waktu saat ini di zona waktu WIB (UTC+7)
 */
function getTimestamp() {
	const now = new Date();
	const utc = now.getTime() + now.getTimezoneOffset() * 60000;
	const wib = new Date(utc + 7 * 3600000);

	const pad = (n) => String(n).padStart(2, "0");
	const d = pad(wib.getDate());
	const mo = pad(wib.getMonth() + 1);
	const y = wib.getFullYear();
	const h = pad(wib.getHours());
	const mi = pad(wib.getMinutes());
	const s = pad(wib.getSeconds());

	return `${d}/${mo}/${y} ${h}:${mi}:${s}`;
}

/**
 * Mendapatkan label chat bersih (nama grup atau [PRIVAT]) tanpa ID/JID WhatsApp
 */
async function getChatLabel(sock, from, isGroup) {
	if (!isGroup) return `${color.blue}[PRIVAT]${color.reset}`;
	if (groupNameCache.has(from)) {
		return `${color.magenta}[GRUP: ${groupNameCache.get(from)}]${color.reset}`;
	}
	try {
		const meta = await sock.groupMetadata(from);
		const name = meta?.subject || "Grup";
		groupNameCache.set(from, name);
		return `${color.magenta}[GRUP: ${name}]${color.reset}`;
	} catch (e) {
		return `${color.magenta}[GRUP]${color.reset}`;
	}
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

		// Identitas bot (JID, LID, dan nomor telepon)
		const botJid = sock.user?.id ? jidNormalizedUser(sock.user.id) : null;
		const botLid = sock.user?.lid ? jidNormalizedUser(sock.user.lid) : null;
		const botNumber = botJid
			? botJid.replace(/[^0-9]/g, "")
			: (config.pairingNumber || "").replace(/[^0-9]/g, "");
		const botLidNumber = botLid ? botLid.replace(/[^0-9]/g, "") : null;

		// Pembersih tag ID/nomor WA untuk tampilan log agar menjadi @NamaBot yang rapi
		const cleanDisplayBody = (txt) => {
			if (!txt) return "";
			let cleaned = txt;
			if (botNumber) cleaned = cleaned.replace(new RegExp(`@${botNumber}`, "g"), `@${config.botName}`);
			if (botLidNumber) cleaned = cleaned.replace(new RegExp(`@${botLidNumber}`, "g"), `@${config.botName}`);
			cleaned = cleaned.replace(/@\d{8,20}/g, `@${config.botName}`);
			return cleaned;
		};

		// Normalisasi nomor pengirim untuk pengecekan status owner
		const senderNumbers = [sender, m.key.participantPn, m.key.senderPn]
			.filter(Boolean)
			.map((jid) => jid.replace(/[^0-9]/g, ""));
		const isOwner = config.ownerNumbers.some((num) => senderNumbers.includes(num.replace(/[^0-9]/g, "")));

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


		// Logging pesan masuk & command (berwarna, bersih tanpa ID WA, jam & tanggal)
		const time = `${color.dim}[${getTimestamp()}]${color.reset}`;
		const chatLabel = await getChatLabel(sock, from, isGroup);
		const displayBody = cleanDisplayBody(trimmedBody);
		const displayPreview = (displayBody.length > 60 ? displayBody.slice(0, 60) + "…" : displayBody).replace(/\n/g, `\n${color.yellow}`);
		const userTag = `${color.bold}[${pushName}]${color.reset}`;

		if (isCommand) {
			console.log(`${time} ${color.green}${color.bold}[CMD]${color.reset} ${chatLabel} ${userTag}: ${color.green}${displayBody}${color.reset}`);
		} else if (trimmedBody) {
			console.log(`${time} ${color.yellow}[MSG]${color.reset} ${chatLabel} ${userTag}: "${displayPreview}"`);
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

		// AI aktif jika:
		// 1. Di grup: bot di-mention ATAU membalas chat bot
		// 2. Di chat privat: langsung aktif (selama mentionOnlyInGroup tidak aktif)
		const shouldTriggerAi = isGroup
			? (isMentioned || isReplyingToBot)
			: !config.ai.mentionOnlyInGroup;

		if (!isCommand && trimmedBody && config.ai.enabled && shouldTriggerAi) {
			const cooldownKey = sender || from;
			const now = Date.now();
			const lastAi = aiCooldownMap.get(cooldownKey) || 0;
			if (now - lastAi >= config.ai.cooldownMs) {
				aiCooldownMap.set(cooldownKey, now);


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
					const aiPreview = (aiReply.length > 70 ? aiReply.slice(0, 70) + "…" : aiReply).replace(/\n/g, `\n${color.cyan}`);
					console.log(`${color.dim}[${getTimestamp()}]${color.reset} ${color.cyan}${color.bold}[AI]${color.reset}  Membalas ${color.bold}[${pushName}]${color.reset}: ${color.cyan}"${aiPreview}"${color.reset}`);
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
