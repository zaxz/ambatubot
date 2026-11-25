const { getContentType, jidNormalizedUser } = require("@whiskeysockets/baileys");
const config = require("../../config");
const { checkAutoReply } = require("./autoReplyHandler");
const { generateReply } = require("../utils/aiClient");
const { downloadMediaBuffer, webpToImage } = require("../utils/mediaHelper");
const { getLimitInfo, consumeLimit } = require("../utils/limitHelper");
const { touchUser, appendChatMessage, getChatHistory, upsertGroup } = require("../utils/db");
const handleCase = require("../case");

const startTime = Date.now();
// Memory cache untuk rate-limiting AI per chat (agar tidak spam jika disebut berulang)
const aiCooldownMap = new Map();
// Cache agar peringatan "limit habis" tidak dikirim berulang-ulang ke user yang sama
const limitNoticeMap = new Map();
// Grup yang sudah dicatat ke SQLite pada proses ini (hindari write berulang)
const recordedGroups = new Set();
const MAX_AI_IMAGE_BYTES = 5 * 1024 * 1024;
const SUPPORTED_AI_IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);

function unwrapMessage(raw) {
	let cur = raw;
	while (cur) {
		if (cur.ephemeralMessage?.message) cur = cur.ephemeralMessage.message;
		else if (cur.viewOnceMessageV2?.message) cur = cur.viewOnceMessageV2.message;
		else if (cur.viewOnceMessage?.message) cur = cur.viewOnceMessage.message;
		else if (cur.documentWithCaptionMessage?.message) cur = cur.documentWithCaptionMessage.message;
		else break;
	}
	return cur;
}

function extractMessageText(unwrappedMsg, msgType) {
	if (!unwrappedMsg || !msgType) return "";
	if (msgType === "conversation") return unwrappedMsg.conversation || "";
	if (msgType === "extendedTextMessage") return unwrappedMsg.extendedTextMessage?.text || "";
	if (msgType === "imageMessage") return unwrappedMsg.imageMessage?.caption || "";
	if (msgType === "videoMessage") return unwrappedMsg.videoMessage?.caption || "";
	if (msgType === "documentMessage") return unwrappedMsg.documentMessage?.caption || "";
	return "";
}

function normalizeImageMime(rawMime) {
	const base = (rawMime || "image/jpeg").split(";")[0].trim().toLowerCase();
	if (base === "image/jpg") return "image/jpeg";
	return SUPPORTED_AI_IMAGE_MIMES.has(base) ? base : "image/jpeg";
}

async function extractAiImage(msg, messageType, quotedMsg, quotedType) {
	try {
		if (messageType === "imageMessage" && msg?.imageMessage?.mediaKey) {
			const buffer = await downloadMediaBuffer(msg.imageMessage, "image");
			if (buffer.length > 0 && buffer.length <= MAX_AI_IMAGE_BYTES) {
				return { mimeType: normalizeImageMime(msg.imageMessage.mimetype), data: buffer.toString("base64") };
			}
		} else if (quotedType === "imageMessage" && quotedMsg?.imageMessage?.mediaKey) {
			const buffer = await downloadMediaBuffer(quotedMsg.imageMessage, "image");
			if (buffer.length > 0 && buffer.length <= MAX_AI_IMAGE_BYTES) {
				return { mimeType: normalizeImageMime(quotedMsg.imageMessage.mimetype), data: buffer.toString("base64") };
			}
		} else if (quotedType === "stickerMessage" && quotedMsg?.stickerMessage?.mediaKey) {
			const webpBuf = await downloadMediaBuffer(quotedMsg.stickerMessage, "sticker");
			const pngBuf = await webpToImage(webpBuf);
			if (pngBuf.length > 0 && pngBuf.length <= MAX_AI_IMAGE_BYTES) {
				return { mimeType: "image/png", data: pngBuf.toString("base64") };
			}
		}
	} catch (err) {
		console.warn("[AI] Gagal memuat gambar untuk AI Vision:", err.message);
	}
	return null;
}
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
 * Pesan yang dikirim saat kuota chat harian user habis.
 * @param {{used: number, limit: number}} info
 */
function buildLimitNotice(info) {
	const ownerNumber = (config.ownerNumbers || [])[0] || "";
	const ownerName = config.ownerName || "owner";
	const waLink = ownerNumber ? `wa.me/${ownerNumber}` : "";
	return (
		`⚠️ *Limit chat harian kamu habis* (${info.used}/${info.limit} terpakai).\n\n` +
		`Limit akan direset otomatis setiap pukul *00.00 WIB*.\n` +
		`Mau nambah limit sekarang? Chat ${ownerName}${waLink ? `: ${waLink}` : ""} biar limitnya ditambahin.`
	);
}

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
		const members = meta?.participants?.length ?? meta?.size ?? null;
		groupNameCache.set(from, name);
		upsertGroup(from, name, members);
		recordedGroups.add(from);
		return `${color.magenta}[GRUP: ${name}]${color.reset}`;
	} catch (e) {
		// Tetap catat grupnya walau nama gagal diambil (sekali per proses)
		if (!recordedGroups.has(from)) {
			upsertGroup(from);
			recordedGroups.add(from);
		}
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

		// Normalisasi nomor pengirim untuk pengecekan status owner (mendukung PN & LID Baileys v7)
		let senderPnAlt = null;
		if (sender && sender.endsWith("@lid") && sock.signalRepository?.lidMapping?.getPNForLID) {
			try {
				senderPnAlt = await sock.signalRepository.lidMapping.getPNForLID(sender);
			} catch (e) {
				// Abaikan jika mapping LID belum tersedia
			}
		}
		const senderNumbers = [
			sender,
			m.key.participantAlt,
			m.key.remoteJidAlt,
			m.key.participantPn,
			m.key.senderPn,
			senderPnAlt,
		]
			.filter(Boolean)
			.map((jid) => jid.split(":")[0].replace(/[^0-9]/g, ""));
		const isOwner = config.ownerNumbers.some((num) => senderNumbers.includes(num.replace(/[^0-9]/g, "")));

		// Identitas limit harian: utamakan nomor HP (PN), fallback ke JID pengirim
		const pnIdentity =
			m.key.participantAlt || m.key.remoteJidAlt || senderPnAlt || (String(sender).endsWith("@lid") ? "" : sender);
		const limitUserId = String(pnIdentity || sender || from).split(":")[0].replace(/[^0-9]/g, "");
		const limitEnabled = config.chatLimit?.enabled !== false;

		// Ekstraksi pesan aktual (antisipasi ephemeral & viewOnce wrapper)
		let msg = unwrapMessage(m.message);
		if (!msg) return;

		const messageType = getContentType(msg) || Object.keys(msg)[0];

		// Ekstraksi teks isi pesan
		const body = extractMessageText(msg, messageType);
		const trimmedBody = body.trim();
		const displayBody = cleanDisplayBody(trimmedBody);
		const prefix = config.botPrefix;
		const isCommand = trimmedBody.startsWith(prefix);

		// Deteksi konteks pesan kutipan (reply/quote) & mention
		const contextInfo = msg[messageType]?.contextInfo || msg?.contextInfo;
		const rawQuoted = contextInfo?.quotedMessage;
		const quotedMsg = rawQuoted ? unwrapMessage(rawQuoted) : null;
		const quotedType = quotedMsg ? (getContentType(quotedMsg) || Object.keys(quotedMsg)[0]) : null;

		// Deteksi apakah bot di-mention di pesan ini
		const mentionedJids = (contextInfo?.mentionedJid || []).map((j) => jidNormalizedUser(j));
		const mentionedNumbers = mentionedJids.map((j) => j.split("@")[0].split(":")[0].replace(/[^0-9]/g, ""));
		const isMentioned =
			Boolean(botJid && mentionedJids.includes(botJid)) ||
			Boolean(botLid && mentionedJids.includes(botLid)) ||
			Boolean(botNumber && (mentionedNumbers.includes(botNumber) || trimmedBody.includes("@" + botNumber))) ||
			Boolean(botLidNumber && (mentionedNumbers.includes(botLidNumber) || trimmedBody.includes("@" + botLidNumber))) ||
			Boolean(config.botName && trimmedBody.toLowerCase().includes("@" + config.botName.toLowerCase()));

		// Deteksi apakah pesan ini membalas (reply) ke pesan bot
		const quotedParticipant = contextInfo?.participant ? jidNormalizedUser(contextInfo.participant) : null;
		let quotedPnAlt = null;
		if (quotedParticipant && quotedParticipant.endsWith("@lid") && sock.signalRepository?.lidMapping?.getPNForLID) {
			try {
				quotedPnAlt = await sock.signalRepository.lidMapping.getPNForLID(quotedParticipant);
			} catch (e) {
				// Abaikan jika mapping LID belum tersedia
			}
		}
		const quotedParticipantNumber = quotedParticipant
			? quotedParticipant.split("@")[0].split(":")[0].replace(/[^0-9]/g, "")
			: null;
		const quotedPnNumber = quotedPnAlt
			? quotedPnAlt.split("@")[0].split(":")[0].replace(/[^0-9]/g, "")
			: null;

		const isReplyingToBot =
			Boolean(botJid && quotedParticipant === botJid) ||
			Boolean(botLid && quotedParticipant === botLid) ||
			Boolean(botNumber && quotedParticipantNumber === botNumber) ||
			Boolean(botLidNumber && quotedParticipantNumber === botLidNumber) ||
			Boolean(botNumber && quotedPnNumber === botNumber) ||
			contextInfo?.fromMe === true ||
			contextInfo?.quotedMessage?.fromMe === true;

		// Apakah pesan ini ditujukan langsung untuk bot?
		// - Di chat privat: semua pesan ditujukan ke bot.
		// - Di grup: HANYA jika berupa command, bot di-mention, atau membalas pesan bot.
		const isTargetedForBot = !isGroup || isCommand || isMentioned || isReplyingToBot;

		// Simpan identitas user (nama, jumlah pesan, terakhir aktif) ke SQLite
		// Hanya catat user jika berinteraksi langsung dengan bot
		if (isTargetedForBot) {
			touchUser(limitUserId, pushName);
		}

		// Tandai pesan sudah dibaca (centang biru) sekali saja per pesan, hanya saat bot menanggapi
		let hasMarkedRead = false;
		const markAsRead = async () => {
			if (hasMarkedRead) return;
			hasMarkedRead = true;
			if (typeof sock.readMessages !== "function") return;
			try {
				await sock.readMessages([m.key]);
			} catch (e) {
				// Abaikan kegagalan read receipt agar proses utama tetap berjalan
			}
		};

		// Otomatis tandai dibaca:
		// - Di chat privat: selalu tandai dibaca (jika privateChat aktif)
		// - Di grup: HANYA tandai dibaca bila pesan ditujukan ke bot (mention / reply bot / command)
		const readCfg = config.readReceipt || {};
		const nonChatTypes = new Set(["protocolMessage", "senderKeyDistributionMessage", "messageContextInfo", "reactionMessage"]);
		const autoReadEnabled =
			readCfg.enabled !== false &&
			!nonChatTypes.has(messageType) &&
			(readCfg.allMessages
				? (isGroup ? readCfg.groups !== false : readCfg.privateChat !== false)
				: (isGroup ? (readCfg.groups !== false && isTargetedForBot) : readCfg.privateChat !== false));

		if (autoReadEnabled) {
			await markAsRead();
		}

		// Logging pesan masuk & command di terminal:
		// HANYA tampilkan log jika di chat privat ATAU di-mention / di-reply di grup / command
		if (isTargetedForBot) {
			const time = `${color.dim}[${getTimestamp()}]${color.reset}`;
			const chatLabel = await getChatLabel(sock, from, isGroup);
			const displayPreview = (displayBody.length > 60 ? displayBody.slice(0, 60) + "…" : displayBody).replace(/\n/g, `\n${color.yellow}`);
			const userTag = `${color.bold}[${pushName}]${color.reset}`;

			if (isCommand) {
				console.log(`${time} ${color.green}${color.bold}[CMD]${color.reset} ${chatLabel} ${userTag}: ${color.green}${displayBody}${color.reset}`);
			} else if (trimmedBody) {
				console.log(`${time} ${color.yellow}[MSG]${color.reset} ${chatLabel} ${userTag}: "${displayPreview}"`);
			}
		}

		// Helper untuk membalas pesan dengan quote otomatis
		const reply = async (text) => {
			await markAsRead();
			await sock.sendMessage(from, { text }, { quoted: m });
		};

		// Kirim peringatan limit habis (dibatasi cooldown agar tidak spam)
		const sendLimitNotice = async (info) => {
			const rawCooldown = config.chatLimit?.noticeCooldownMs;
			const cooldown = Number.isFinite(Number(rawCooldown)) ? Math.max(0, Number(rawCooldown)) : 60000;
			const lastNotice = limitNoticeMap.get(limitUserId) || 0;
			if (Date.now() - lastNotice < cooldown) return;
			limitNoticeMap.set(limitUserId, Date.now());
			await reply(buildLimitNotice(info)).catch(() => {});
		};

		// =========================================================================
		// 1. ROUTING COMMAND (JIKA DIAWALI PREFIX MISAL '.')
		// =========================================================================
		if (isCommand) {
			const args = trimmedBody.slice(prefix.length).trim().split(/ +/);
			const command = args[0].toLowerCase();
			const text = args.slice(1).join(" ");

			// Command dianggap "dibaca" bot, termasuk perintah yang mengirim media tanpa teks
			await markAsRead();
			// Command fitur berat (stiker & media) memotong limit harian; info command tetap gratis
			const HEAVY_COMMANDS = new Set(["s", "sticker", "stiker", "saudio", "stickeraudio", "audiosticker", "stikeraudio", "smeme", "stickermeme", "stikermeme", "brat", "bratstiker", "bratsticker", "bratvid", "bratvideo", "bratgif", "toimg", "iqc", "iphonequote", "iphonechat"]);
			if (limitEnabled && !isOwner && HEAVY_COMMANDS.has(command)) {
				const cmdLimitInfo = getLimitInfo(limitUserId);
				if (cmdLimitInfo.remaining <= 0) {
					await sendLimitNotice(cmdLimitInfo);
					return;
				}
				consumeLimit(limitUserId);
			}
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
				botJid,
				botLid,
				limitUserId,
			});
			return;
		}

		// =========================================================================
		// 1.5. AI BALASAN SERTAMAN (MENTION / BALAS KE PESAN BOT)
		// =========================================================================
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

				// Bot membaca pesan sebelum membalas AI
				await markAsRead();

				// Cek limit chat harian (owner bebas limit)
				if (limitEnabled && !isOwner) {
					const limitInfo = getLimitInfo(limitUserId);
					if (limitInfo.remaining <= 0) {
						console.log(`${color.dim}[${getTimestamp()}]${color.reset} ${color.yellow}[LIMIT]${color.reset} ${color.bold}[${pushName}]${color.reset} kuota habis (${limitInfo.used}/${limitInfo.limit})`);
						await sendLimitNotice(limitInfo);
						return;
					}
				}

				// Indikator 'sedang mengetik...' (best-effort, tidak blokir balasan)
				try {
					await sock.sendPresenceUpdate("composing", from);
				} catch (e) {
					// Abaikan gagal presence
				}

				// Bersihkan tag @bot (nomor HP, LID, atau nama bot) agar prompt ke AI bersih
				let cleanMessage = trimmedBody;
				if (botNumber) {
					cleanMessage = cleanMessage.replace(new RegExp(`@${botNumber}`, "g"), "");
				}
				if (botLidNumber) {
					cleanMessage = cleanMessage.replace(new RegExp(`@${botLidNumber}`, "g"), "");
				}
				if (config.botName) {
					cleanMessage = cleanMessage.replace(new RegExp(`@${config.botName}`, "gi"), "");
				}
				cleanMessage = cleanMessage.replace(/@\d+/g, "").trim();

				const history = getChatHistory(from);
				const quotedText = quotedMsg ? cleanDisplayBody(extractMessageText(quotedMsg, quotedType).trim()) : "";
				const aiImage = await extractAiImage(msg, messageType, quotedMsg, quotedType);

				const lastHistoryEntry = history[history.length - 1];
				const isSameAsLastModel =
					lastHistoryEntry && lastHistoryEntry.role === "model" && lastHistoryEntry.text === quotedText;

				const quotedContext =
					quotedText && !isSameAsLastModel
						? { sender: isReplyingToBot ? config.botName : "Pengguna lain", text: quotedText }
						: null;

				if (!cleanMessage) {
					if (aiImage) cleanMessage = "Tolong lihat dan jelaskan atau tanggapi gambar ini.";
					else if (quotedText) cleanMessage = "Tolong tanggapi atau jelaskan pesan yang dibalas ini.";
					else cleanMessage = trimmedBody;
				}

				const groupName = isGroup ? groupNameCache.get(from) : null;

				try {
					const aiReply = await generateReply({
						message: cleanMessage,
						senderName: pushName,
						groupName,
						history,
						quotedContext,
						image: aiImage,
						botName: config.botName,
						config,
					});
					await sock.sendMessage(from, { text: aiReply }, { quoted: m });
					if (limitEnabled && !isOwner) {
						const after = consumeLimit(limitUserId);
						if (after) {
							console.log(`${color.dim}[${getTimestamp()}]${color.reset} ${color.yellow}[LIMIT]${color.reset} ${color.bold}[${pushName}]${color.reset} sisa ${after.remaining}/${after.limit}`);
						}
					}
					const userHistoryText = isGroup ? `[${pushName}]: ${cleanMessage}` : cleanMessage;
					appendChatMessage(from, limitUserId, "user", userHistoryText);
					appendChatMessage(from, limitUserId, "model", aiReply);
					const aiPreview = (aiReply.length > 70 ? aiReply.slice(0, 70) + "…" : aiReply).replace(/\n/g, `\n${color.cyan}`);
					console.log(`${color.dim}[${getTimestamp()}]${color.reset} ${color.cyan}${color.bold}[AI]${color.reset}  Membalas ${color.bold}[${pushName}]${color.reset}: ${color.cyan}"${aiPreview}"${color.reset}`);
				} catch (err) {
					console.error("[AI] Error saat memproses/mengirim balasan AI:", err.message);
					await reply("Maaf, AI sedang gangguan. Coba lagi nanti.").catch(() => {});
				} finally {
					try {
						await sock.sendPresenceUpdate("paused", from);
					} catch (e) {
						// Abaikan gagal update presence
					}
				}
			}
			return;
		}

		// =========================================================================
		// 2. OTOMATISASI PESAN / AUTO-RESPONDER NON-COMMAND (FAQ & KEYWORDS)
		// =========================================================================
		if (!isCommand && trimmedBody) {
			// Simpan obrolan biasa ke memori agar AI nyambung jika di-mention setelahnya
			const historyLine = isGroup ? `[${pushName}]: ${displayBody}` : displayBody;
			appendChatMessage(from, limitUserId, "user", historyLine);

			if (config.autoReply.privateOnly && isGroup) {
				return; // Jangan respon di grup jika disetel khusus chat pribadi
			}

			const autoReplyText = checkAutoReply(trimmedBody, sender, pushName);
			if (autoReplyText) {
				// Auto-reply termasuk "chat" bila countAutoReply aktif
				const countAutoReply = config.chatLimit?.countAutoReply !== false;
				if (limitEnabled && !isOwner && countAutoReply) {
					const limitInfo = getLimitInfo(limitUserId);
					if (limitInfo.remaining <= 0) {
						await sendLimitNotice(limitInfo);
						return;
					}
					consumeLimit(limitUserId);
				}

				await markAsRead();
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
