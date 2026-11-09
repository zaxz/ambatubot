const config = require("../config");
const {
	downloadMediaBuffer,
	imageToWebp,
	videoToWebp,
	webpToImage,
	addExif,
	createMemeSticker,
	createBratSticker,
} = require("./utils/mediaHelper");
const { sendBroadcast } = require("./handlers/broadcastHandler");
const { getJadwalKuliah } = require("./utils/jadwalHelper");
const { getPjMatkul } = require("./utils/pjHelper");

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

	switch (command) {
		// =========================================================================
		// MENU / BANTUAN
		// =========================================================================
		case "menu":
		case "help": {
			const uptime = formatUptime(Date.now() - startTime);
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
┃   _Bikin stiker teks brat (meme putih)._
┃ • *${prefix}toimg*
┃   _Ubah stiker jadi gambar kembali._
┣━━━❰ 📚 *AKADEMIK & JADWAL* ❱━━━┫
┃ • *${prefix}jadwal* <kelas> [hari]
┃   _Cek jadwal (hari ini, besok, lusa, semua)._
┃ • *${prefix}pj* <kelas> <matkul>
┃   _Cek PJ matkul & nomor WA dosen._
┃
┣━━━❰ ⚡ *INFO & SISTEM* ❱━━━┫
┃ • *${prefix}ping* - Cek respon & latensi
┃ • *${prefix}runtime* - Status server & RAM
┣━━━❰ 📢 *OWNER* ❱━━━┫
┃ • *${prefix}bc* <teks> - Kirim broadcast
┃
╰━━━━━━━━━━━━━━━━━━━━━━━╯
_Kirim gambar dengan caption *${prefix}s* atau *${prefix}smeme Teks*!_`;

			await sock.sendMessage(sender, { text: menuText });
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
		case "pjmatkul":
		case "dosen": {
			const result = getPjMatkul(text, prefix);
			await reply(result);
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

			await reply("⏳ Sedang memproses stiker, mohon tunggu sebentar...");

			try {
				let stickerBuffer;

				if (isDirectImage || isQuotedImage) {
					const targetMedia = isDirectImage ? msg.imageMessage : quotedMsg.imageMessage;
					const rawBuffer = await downloadMediaBuffer(targetMedia, "image");
					const webpBuffer = await imageToWebp(rawBuffer);
					stickerBuffer = await addExif(webpBuffer, packname, author);
				} else if (isDirectVideo || isQuotedVideo) {
					const targetMedia = isDirectVideo ? msg.videoMessage : quotedMsg.videoMessage;

					const seconds = targetMedia.seconds || 0;
					if (seconds > config.sticker.maxVideoDurationSeconds) {
						return await reply(
							`⚠️ Durasi video terlalu panjang! Maksimal adalah *${config.sticker.maxVideoDurationSeconds} detik*.`
						);
					}

					const rawBuffer = await downloadMediaBuffer(targetMedia, "video");
					const webpBuffer = await videoToWebp(rawBuffer, config.sticker.maxVideoDurationSeconds);
					stickerBuffer = await addExif(webpBuffer, packname, author);
				}

				await sock.sendMessage(from, { sticker: stickerBuffer }, { quoted: m });
			} catch (err) {
				console.error("Error saat membuat stiker:", err);
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

			await reply("⏳ Sedang membuat stiker meme...");

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
			} catch (err) {
				console.error("Error saat membuat smeme:", err);
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

			await reply("⏳ Sedang membuat stiker brat...");

			try {
				const rawBratWebp = await createBratSticker(bratText.trim());
				const finalSticker = await addExif(rawBratWebp, config.sticker.packName, config.sticker.packAuthor);

				await sock.sendMessage(from, { sticker: finalSticker }, { quoted: m });
			} catch (err) {
				console.error("Error saat membuat stiker brat:", err);
				await reply(`❌ Gagal membuat stiker brat: ${err.message}`);
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

			try {
				await reply("⏳ Mengonversi stiker ke gambar...");
				const rawSticker = await downloadMediaBuffer(quotedMsg.stickerMessage, "sticker");
				const pngBuffer = await webpToImage(rawSticker);

				await sock.sendMessage(
					from,
					{ image: pngBuffer, caption: "✅ Berhasil mengubah stiker menjadi gambar!" },
					{ quoted: m }
				);
			} catch (err) {
				console.error("Error saat toimg:", err);
				await reply(`❌ Gagal mengonversi stiker ke gambar: ${err.message}`);
			}
			break;
		}

		// =========================================================================
		// BROADCAST OTOMATIS (.bc)
		// =========================================================================
		case "bc":
		case "broadcast": {
			if (!isOwner) {
				return await reply("⛔ Perintah ini hanya dapat digunakan oleh Pemilik (Owner) Bot!");
			}

			if (!text) {
				return await reply(
					`⚠️ Format broadcast salah!\nContoh: *${prefix}bc Pengumuman penting untuk semua pelanggan!*`
				);
			}

			await reply("📢 Memulai proses broadcast pesan dengan jeda anti-spam...");

			const targetList = config.ownerNumbers.map((num) => `${num.replace(/[^0-9]/g, "")}@s.whatsapp.net`);

			const broadcastContent = {
				text: `📢 *PESAN SIARAN RESMI*\n\n${text}\n\n_Pesan otomatis dikirim oleh ${config.botName}_`,
			};

			const result = await sendBroadcast(sock, targetList, broadcastContent, (prog) => {
				console.log(`[Broadcast] Progres: ${prog.current}/${prog.total} - ${prog.jid} (${prog.status})`);
			});

			await reply(
				`✅ *Broadcast Selesai!*\n• Berhasil: ${result.success}\n• Gagal: ${result.failed}\n• Total Tujuan: ${targetList.length}`
			);
			break;
		}

		default:
			// Perintah tidak dikenal
			break;
	}
}

module.exports = handleCase;
