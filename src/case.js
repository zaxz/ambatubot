const axios = require("axios");
const config = require("../config");
const {
	downloadMediaBuffer,
	imageToWebp,
	videoToWebp,
	webpToImage,
	addExif,
	createMemeSticker,
	createBratSticker,
	createBratVideoSticker,
} = require("./utils/mediaHelper");
const { getJadwalKuliah, formatDosenInfo, searchDosenSchedules } = require("./utils/jadwalHelper");
const { getPjMatkul } = require("./utils/pjHelper");
const { createIqcImage } = require("./utils/iqcHelper");

/**
 * Format durasi waktu ke teks terbaca (hari, jam, menit, detik)
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
 * Handler utama untuk semua perintah switch-case bot
 * Tambah atau ubah fitur perintah baru langsung di dalam switch (command) di bawah!
 */
async function handleCase(context) {
	const {
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
	} = context;

	// Helper untuk memberi reaksi emoji ke pesan masuk (best-effort)
	const react = async (emoji) => {
		try {
			await sock.sendMessage(from, {
				react: {
					text: emoji,
					key: m.key,
				},
			});
		} catch (e) {
			// Abaikan gagal reaksi agar proses utama tetap berjalan
		}
	};

	switch (command) {
		// =========================================================================
		// MENU / BANTUAN
		// =========================================================================
		case "menu":
		case "help": {
			const uptime = formatUptime(Date.now() - startTime);
			const ownerSection = isOwner
				? `┣━━━❰ 📢 *OWNER* ❱━━━┫\n` +
				  `┃ • *${prefix}listgrup* - Daftar grup bot (Owner)\n` +
				  `┃ • *${prefix}join* <link> - Gabung ke grup (Owner)\n` +
				  `┃ • *${prefix}leave* [no/id] - Keluar grup (Owner)\n`
				: "";
			const menuText = `╭━━━❰ *${config.botName}* ❱━━━╮
┃
┃ 🤖 *Status Bot:* Online
┃ ⏱️ *Uptime:* ${uptime}
┃ 🏷️ *Prefix:* [ ${prefix} ]
┃
┣━━━❰ 🎨 *FITUR STIKER* ❱━━━┫
┃ • *${prefix}s* / *${prefix}sticker*
┃   _Ubah gambar/video/gif jadi stiker._
┃ • *${prefix}smeme* <atas> | <bawah>
┃   _Bikin stiker meme dengan teks._
┃ • *${prefix}brat* <teks>
┃   _Bikin stiker teks brat putih (teks besar, emoji berwarna, blur)._
┃ • *${prefix}bratvid* <teks>
┃   _Bikin stiker teks brat bergerak kata demi kata._
┃ • *${prefix}toimg*
┃   _Ubah stiker jadi gambar kembali._
┃ • *${prefix}iqc* <teks>
┃   _Bikin iPhone Quoted Chat (kiri default, atau aku | teks untuk kanan)._
┣━━━❰ 📚 *AKADEMIK & JADWAL* ❱━━━┫
┃ • *${prefix}jadwal* <kelas> [hari]
┃   _Cek jadwal (hari ini, besok, lusa, semua)._
┃ • *${prefix}pj* <kelas> <matkul>
┃   _Cek PJ matkul & nomor WA dosen._
┃ • *${prefix}dosen* <nama>
┃   _Cari kelas & jadwal mengajar dosen (semua kelas)._
┃
┣━━━❰ ⚡ *INFO & SISTEM* ❱━━━┫
┃ • *${prefix}ping* - Cek respon & latensi
┃ • *${prefix}runtime* - Status server & RAM
${ownerSection}┃
╰━━━━━━━━━━━━━━━━━╯
_Kirim gambar dengan caption *${prefix}s* atau *${prefix}smeme Teks*!_`;

			await reply(menuText);
			break;
		}

		// =========================================================================
		// CEK KONEKSI & RUNTIME
		// =========================================================================
		case "ping": {
			const startPing = Date.now();
			await reply("🏓 Pong!");
			const latency = Date.now() - startPing;
			await sock.sendMessage(from, { text: `⚡ Respon bot: *${latency} ms*` }, { quoted: m });
			break;
		}

		case "runtime":
		case "status": {
			const uptime = formatUptime(Date.now() - startTime);
			const mem = process.memoryUsage();
			const memUsed = Math.round(mem.rss / 1024 / 1024);
			const statusText = `📊 *STATUS SISTEM BOT:*\n• *Uptime:* ${uptime}\n• *Node.js:* ${process.version}\n• *RAM Usage:* ${memUsed} MB\n• *Platform:* ${process.platform} (${process.arch})`;
			await reply(statusText);
			break;
		}

		// =========================================================================
		// JADWAL KULIAH (.jadwal <kelas> [hari ini/besok/lusa/hari/semua])
		// =========================================================================
		case "jadwal":
		case "jadwalkuliah":
		case "kuliah": {
			const result = getJadwalKuliah(text, prefix);
			await reply(result);
			break;
		}

		// =========================================================================
		// PENANGGUNG JAWAB MATKUL (.pj <kelas> <matkul>)
		// =========================================================================
		case "pj":
		case "pjmatkul": {
			const rawQuery = (text || "").trim();
			// Tanpa kode kelas di awal → anggap pencarian dosen lintas kelas
			const startsWithClassCode = /^[1-8]\s?[a-z]\s?\d{2}/i.test(rawQuery);
			if (rawQuery && !startsWithClassCode && searchDosenSchedules(rawQuery).length > 0) {
				await reply(formatDosenInfo(rawQuery, prefix));
				break;
			}
			const result = getPjMatkul(text, prefix);
			await reply(result);
			break;
		}

		// =========================================================================
		// CARI DOSEN: KELAS & JADWAL MENGAJAR DI SEMUA KELAS (.dosen <nama>)
		// =========================================================================
		case "dosen":
		case "caridosen":
		case "dosenmana": {
			const keyword = (text || "").trim();
			if (!keyword) {
				return await reply(
					`👨‍🏫 *CARI DOSEN (SEMUA KELAS)*\n\nContoh penggunaan:\n` +
					`• *${prefix}dosen moses*\n` +
					`• *${prefix}dosen widiyono*\n` +
					`• *${prefix}dosen eko budi*\n\n` +
					`Atau tanya bebas ke bot: _"pak moses lagi ngajar di kelas mana?"_`
				);
			}
			// Kompatibilitas lama: ".dosen <kelas> <matkul>" tetap menampilkan data PJ
			if (/^[1-8]\s?[a-z]\s?\d{2}/i.test(keyword)) {
				await reply(getPjMatkul(keyword, prefix));
				break;
			}
			await reply(formatDosenInfo(keyword, prefix));
			break;
		}

		// =========================================================================
		// PEMBUATAN STIKER WHATSAPP (.s / .sticker)
		// =========================================================================
		case "s":
		case "sticker":
		case "stiker": {
			const packname = config.sticker.packName;
			const author = config.sticker.packAuthor;

			const isDirectImage = messageType === "imageMessage";
			const isDirectVideo = messageType === "videoMessage";
			const isQuotedImage = quotedType === "imageMessage";
			const isQuotedVideo = quotedType === "videoMessage";

			if (!isDirectImage && !isDirectVideo && !isQuotedImage && !isQuotedVideo) {
				return await reply(
					`⚠️ *Format Tidak Sesuai!*\n\nSilakan:\n1. Kirim gambar/video dengan caption *${prefix}s*\n2. Atau balas (reply) gambar/video yang sudah ada dengan pesan *${prefix}s*`
				);
			}

			if (isDirectVideo || isQuotedVideo) {
				const targetVideo = isDirectVideo ? msg.videoMessage : quotedMsg.videoMessage;
				const seconds = targetVideo.seconds || 0;
				if (seconds > config.sticker.maxVideoDurationSeconds) {
					return await reply(
						`⚠️ Durasi video terlalu panjang! Maksimal adalah *${config.sticker.maxVideoDurationSeconds} detik*.`
					);
				}
			}

			await react("⏳");

			try {
				let stickerBuffer;

				if (isDirectImage || isQuotedImage) {
					const targetMedia = isDirectImage ? msg.imageMessage : quotedMsg.imageMessage;
					const rawBuffer = await downloadMediaBuffer(targetMedia, "image");
					const webpBuffer = await imageToWebp(rawBuffer);
					stickerBuffer = await addExif(webpBuffer, packname, author);
				} else if (isDirectVideo || isQuotedVideo) {
					const targetMedia = isDirectVideo ? msg.videoMessage : quotedMsg.videoMessage;
					const rawBuffer = await downloadMediaBuffer(targetMedia, "video");
					const webpBuffer = await videoToWebp(rawBuffer, config.sticker.maxVideoDurationSeconds);
					stickerBuffer = await addExif(webpBuffer, packname, author);
				}

				await sock.sendMessage(from, { sticker: stickerBuffer }, { quoted: m });
				await react("✅");
			} catch (err) {
				console.error("Error saat membuat stiker:", err);
				await react("❌");
				await reply(`❌ Gagal membuat stiker: ${err.message}`);
			}
			break;
		}

		// =========================================================================
		// MEMBUAT STIKER MEME (.smeme / .stickermeme)
		// =========================================================================
		case "smeme":
		case "stickermeme":
		case "stikermeme": {
			if (!text) {
				return await reply(
					`⚠️ *Format Perintah Salah!*\n\nContoh penggunaan:\n` +
					`• *${prefix}smeme Teks Bawah*\n` +
					`• *${prefix}smeme Teks Atas | Teks Bawah*\n\n` +
					`Kirim dengan gambar, atau balas (reply) foto/stiker yang sudah ada.`
				);
			}

			let topText = "";
			let bottomText = "";
			if (text.includes("|")) {
				const parts = text.split("|");
				topText = parts[0]?.trim() || "";
				bottomText = parts.slice(1).join("|")?.trim() || "";
			} else {
				bottomText = text.trim();
			}

			const isDirectImage = messageType === "imageMessage";
			const isQuotedImage = quotedType === "imageMessage";
			const isQuotedSticker = quotedType === "stickerMessage";

			if (!isDirectImage && !isQuotedImage && !isQuotedSticker) {
				return await reply(
					`⚠️ *Gambar Tidak Ditemukan!*\n\nSilakan:\n` +
					`1. Kirim gambar dengan caption *${prefix}smeme ${text}*\n` +
					`2. Atau balas (reply) foto/stiker dengan *${prefix}smeme ${text}*`
				);
			}

			await react("⏳");

			try {
				let rawImageBuffer;
				if (isDirectImage) {
					rawImageBuffer = await downloadMediaBuffer(msg.imageMessage, "image");
				} else if (isQuotedImage) {
					rawImageBuffer = await downloadMediaBuffer(quotedMsg.imageMessage, "image");
				} else if (isQuotedSticker) {
					const stickerBuffer = await downloadMediaBuffer(quotedMsg.stickerMessage, "sticker");
					rawImageBuffer = await webpToImage(stickerBuffer);
				}

				const memeWebp = await createMemeSticker(rawImageBuffer, topText, bottomText);
				const finalSticker = await addExif(memeWebp, config.sticker.packName, config.sticker.packAuthor);

				await sock.sendMessage(from, { sticker: finalSticker }, { quoted: m });
				await react("✅");
			} catch (err) {
				console.error("Error saat membuat smeme:", err);
				await react("❌");
				await reply(`❌ Gagal membuat stiker meme: ${err.message}`);
			}
			break;
		}

		// =========================================================================
		// STIKER TEKS BRAT (.brat <teks>)
		// =========================================================================
		case "brat":
		case "bratstiker":
		case "bratsticker": {
			const bratText =
				text ||
				(quotedMsg ? (quotedMsg.conversation || quotedMsg.extendedTextMessage?.text) : "");

			if (!bratText || !bratText.trim()) {
				return await reply(
					`⚠️ *Teks Tidak Ditemukan!*\n\nContoh penggunaan:\n` +
					`• *${prefix}brat sok iye loe jadi orang*\n` +
					`• *${prefix}brat kamu nanya*\n\n` +
					`Atau balas (reply) pesan teks apa pun dengan *${prefix}brat*`
				);
			}

			await react("⏳");

			try {
				const rawBratWebp = await createBratSticker(bratText.trim());
				const finalSticker = await addExif(rawBratWebp, config.sticker.packName, config.sticker.packAuthor);

				await sock.sendMessage(from, { sticker: finalSticker }, { quoted: m });
				await react("✅");
			} catch (err) {
				console.error("Error saat membuat stiker brat:", err);
				await react("❌");
				await reply(`❌ Gagal membuat stiker brat: ${err.message}`);
			}
			break;
		}

		// =========================================================================
		// STIKER TEKS BRAT BERGERAK (.bratvid <teks>)
		// =========================================================================
		case "bratvid":
		case "bratvideo":
		case "bratgif": {
			const bratText =
				text ||
				(quotedMsg
					? quotedMsg.conversation ||
					  quotedMsg.extendedTextMessage?.text ||
					  quotedMsg.imageMessage?.caption ||
					  quotedMsg.videoMessage?.caption
					: "");

			if (!bratText || !bratText.trim()) {
				return await reply(
					`⚠️ *Teks Tidak Ditemukan!*\n\nContoh penggunaan:\n` +
					`• *${prefix}bratvid sok iye loe jadi orang*\n` +
					`• *${prefix}bratvid kamu nanya*\n\n` +
					`Atau balas (reply) pesan teks apa pun dengan *${prefix}bratvid*`
				);
			}

			await react("⏳");

			try {
				const rawBratVid = await createBratVideoSticker(
					bratText.trim(),
					config.sticker.maxVideoDurationSeconds
				);
				const finalSticker = await addExif(rawBratVid, config.sticker.packName, config.sticker.packAuthor);

				await sock.sendMessage(from, { sticker: finalSticker }, { quoted: m });
				await react("✅");
			} catch (err) {
				console.error("Error saat membuat stiker bratvid:", err);
				await react("❌");
				await reply(`❌ Gagal membuat stiker bratvid: ${err.message}`);
			}
			break;
		}

		// =========================================================================
		// UBAH STIKER MENJADI GAMBAR (.toimg)
		// =========================================================================
		case "toimg": {
			const isQuotedSticker = quotedType === "stickerMessage";
			if (!isQuotedSticker) {
				return await reply(
					`⚠️ Balas (reply) stiker yang ingin Anda ubah menjadi gambar dengan mengetik *${prefix}toimg*`
				);
			}

			await react("⏳");

			try {
				const rawSticker = await downloadMediaBuffer(quotedMsg.stickerMessage, "sticker");
				const pngBuffer = await webpToImage(rawSticker);

				await sock.sendMessage(from, { image: pngBuffer }, { quoted: m });
				await react("✅");
			} catch (err) {
				console.error("Error saat toimg:", err);
				await react("❌");
				await reply(`❌ Gagal mengonversi stiker ke gambar: ${err.message}`);
			}
			break;
		}

		// =========================================================================
		// IPHONE QUOTED CHAT (.iqc <teks> | .iqc <nama> | <teks> | reply pesan)
		// =========================================================================
		case "iqc":
		case "iphonequote":
		case "iphonechat": {
			const quotedText = quotedMsg
				? (
					quotedMsg.conversation ||
					quotedMsg.extendedTextMessage?.text ||
					quotedMsg.imageMessage?.caption ||
					quotedMsg.videoMessage?.caption ||
					""
				).trim()
				: "";

			const rawInput = text.trim();
			if (!rawInput && !quotedText) {
				return await reply(
					`⚠️ *Teks Tidak Ditemukan!*\n\nContoh penggunaan:\n` +
					`• *${prefix}iqc Terkadang aku merasa pantas diabaikan...*\n` +
					`• *${prefix}iqc aku | biar semesta aja yg atur 🙏*\n\n` +
					`Atau balas (reply) pesan seseorang lalu ketik *${prefix}iqc*`
				);
			}

			await react("⏳");

			try {
				let quoteText = rawInput;
				let side = "other";
				let avatarTarget = isGroup ? from : sender;

				if (rawInput.includes("|")) {
					const pipeIdx = rawInput.indexOf("|");
					const customSide = rawInput.slice(0, pipeIdx).trim().toLowerCase();
					const customText = rawInput.slice(pipeIdx + 1).trim();
					quoteText = customText || quotedText;

					if (!quoteText) {
						await react("❌");
						return await reply(`⚠️ Teks setelah tanda \`|\` masih kosong.`);
					}

					const selfAliases = ["aku", "me", "gw", "gue", "saya", "kanan", "you"];
					side = selfAliases.includes(customSide) ? "you" : "other";
					avatarTarget = side === "you" ? sender : (contextInfo?.participant || avatarTarget);
				} else if (!rawInput && quotedText) {
					quoteText = quotedText;
					const quotedParticipant = contextInfo?.participant || null;
					const cleanParticipant = quotedParticipant ? quotedParticipant.replace(/[^0-9]/g, "") : "";
					const cleanBotJid = context.botJid ? context.botJid.replace(/[^0-9]/g, "") : "";
					const cleanBotLid = context.botLid ? context.botLid.replace(/[^0-9]/g, "") : "";

					const isQuotedBot =
						contextInfo?.quotedMessage?.fromMe === true ||
						(cleanParticipant && (cleanParticipant === cleanBotJid || cleanParticipant === cleanBotLid));

					side = isQuotedBot ? "you" : "other";
					avatarTarget = isGroup ? from : (quotedParticipant || sender);
				}

				let avatarBuffer = null;
				if (avatarTarget && typeof sock.profilePictureUrl === "function") {
					try {
						const ppUrl = await sock.profilePictureUrl(avatarTarget, "image");
						if (ppUrl) {
							const res = await axios.get(ppUrl, { responseType: "arraybuffer", timeout: 4000 });
							avatarBuffer = Buffer.from(res.data);
						}
					} catch (e) {
						// Foto profil tidak tersedia/privat → pakai siluet header default
					}
				}

				const iqcPng = await createIqcImage({
					text: quoteText,
					side,
					avatarBuffer,
				});

				await sock.sendMessage(from, { image: iqcPng }, { quoted: m });
				await react("✅");
			} catch (err) {
				console.error("Error saat membuat gambar iqc:", err);
				await react("❌");
				await reply(`❌ Gagal membuat gambar iqc: ${err.message}`);
			}
			break;
		}

		// =========================================================================
		// DAFTAR GRUP YANG DIIKUTI BOT (.listgrup - KHUSUS OWNER)
		// =========================================================================
		case "listgrup":
		case "listgroup": {
			if (!isOwner) {
				return await reply("⛔ Perintah ini hanya dapat digunakan oleh Pemilik (Owner) Bot!");
			}

			await react("⏳");

			try {
				const groupsMap = await sock.groupFetchAllParticipating();
				const groups = Object.values(groupsMap || {}).sort((a, b) =>
					(a.subject || "").localeCompare(b.subject || "", "id")
				);

				if (groups.length === 0) {
					await reply("ℹ️ Bot saat ini belum tergabung di grup mana pun.");
					await react("✅");
					break;
				}

				const lines = groups.map((g, idx) => {
					const name = g.subject || "Tanpa Nama";
					const members = g.size ?? g.participants?.length ?? 0;
					const tag = g.isCommunity ? " _(Komunitas)_" : "";
					return `${idx + 1}. *${name}*${tag}\n   👥 ${members} anggota`;
				});

				await reply(`📋 *DAFTAR GRUP (${groups.length})*\n\n${lines.join("\n\n")}`);
				await react("✅");
			} catch (err) {
				console.error("Error saat mengambil daftar grup:", err);
				await react("❌");
				await reply(`❌ Gagal mengambil daftar grup: ${err.message}`);
			}
			break;
		}

		// =========================================================================
		// GABUNG GRUP VIA LINK UNDANGAN (.join - KHUSUS OWNER)
		// =========================================================================
		case "join": {
			if (!isOwner) {
				return await reply("⛔ Perintah ini hanya dapat digunakan oleh Pemilik (Owner) Bot!");
			}

			const linkMatch = text.match(/chat\.whatsapp\.com\/([0-9A-Za-z]{20,})/i);
			const inviteCode = linkMatch ? linkMatch[1] : (/^[0-9A-Za-z]{20,}$/.test(text.trim()) ? text.trim() : "");

			if (!inviteCode) {
				return await reply(
					`⚠️ *Link Undangan Tidak Valid!*\n\nContoh:\n• *${prefix}join https://chat.whatsapp.com/AbCdEfGhIjKlMnOpQrStUv*`
				);
			}

			await react("⏳");

			try {
				const groupJid = await sock.groupAcceptInvite(inviteCode);
				let groupName = "grup";
				if (groupJid) {
					try {
						const meta = await sock.groupMetadata(groupJid);
						if (meta?.subject) groupName = `*${meta.subject}*`;
					} catch (e) {
						// Abaikan jika gagal mengambil nama grup
					}
				}
				await reply(`✅ Berhasil bergabung ke ${groupName}!`);
				await react("✅");
			} catch (err) {
				console.error("Error saat join grup:", err);
				await react("❌");
				await reply(`❌ Gagal masuk ke grup: ${err.message}`);
			}
			break;
		}

		// =========================================================================
		// KELUARKAN BOT DARI GRUP (.leave - KHUSUS OWNER)
		// =========================================================================
		case "leave":
		case "keluar": {
			if (!isOwner) {
				return await reply("⛔ Perintah ini hanya dapat digunakan oleh Pemilik (Owner) Bot!");
			}

			const arg = text.trim();

			if (!arg) {
				if (!isGroup) {
					return await reply(
						`⚠️ Gunakan perintah ini di dalam grup, atau masukkan nomor urut dari *${prefix}listgrup*.\nContoh: *${prefix}leave 1*`
					);
				}
				await reply("👋 Bot keluar dari grup ini.");
				await react("✅");
				try {
					await sock.groupLeave(from);
				} catch (err) {
					console.error("Error saat leave grup:", err);
					await react("❌");
					await reply(`❌ Gagal keluar dari grup: ${err.message}`);
				}
				break;
			}

			await react("⏳");

			try {
				let targetJid = null;
				let targetName = arg;

				if (/^\d+$/.test(arg)) {
					const groupsMap = await sock.groupFetchAllParticipating();
					const groups = Object.values(groupsMap || {}).sort((a, b) =>
						(a.subject || "").localeCompare(b.subject || "", "id")
					);
					const chosen = groups[Number(arg) - 1];
					if (!chosen) {
						await react("❌");
						return await reply(
							`⚠️ Nomor grup *${arg}* tidak ditemukan. Cek urutan lewat *${prefix}listgrup*.`
						);
					}
					targetJid = chosen.id;
					targetName = chosen.subject || chosen.id;
				} else if (arg.endsWith("@g.us")) {
					targetJid = arg;
					try {
						const meta = await sock.groupMetadata(targetJid);
						if (meta?.subject) targetName = meta.subject;
					} catch (e) {
						// Pakai JID sebagai fallback nama
					}
				} else {
					await react("❌");
					return await reply(
						`⚠️ Format tidak valid! Masukkan nomor urut dari *${prefix}listgrup* atau ID grup (\`@g.us\`).`
					);
				}

				if (targetJid === from) {
					await reply("👋 Bot keluar dari grup ini.");
					await react("✅");
					await sock.groupLeave(targetJid);
				} else {
					await sock.groupLeave(targetJid);
					await reply(`✅ Berhasil keluar dari grup *${targetName}*.`);
					await react("✅");
				}
			} catch (err) {
				console.error("Error saat leave grup:", err);
				await react("❌");
				await reply(`❌ Gagal keluar dari grup: ${err.message}`);
			}
			break;
		}

		default:
			// Perintah tidak dikenal
			break;
	}
}

module.exports = handleCase;
