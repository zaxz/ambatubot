const { downloadContentFromMessage } = require("@whiskeysockets/baileys");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const webp = require("node-webpmux");
const axios = require("axios");

/**
 * Download media buffer dari pesan Baileys
 * @param {Object} messageObj - imageMessage, videoMessage, atau stickerMessage
 * @param {string} mediaType - 'image', 'video', atau 'sticker'
 * @returns {Promise<Buffer>}
 */
async function downloadMediaBuffer(messageObj, mediaType) {
	if (!messageObj) throw new Error("Objek pesan media tidak ditemukan");

	// Buka wrapper jika masih terbungkus viewOnce atau tipe pesan bersarang
	let media = messageObj;
	if (media.viewOnceMessageV2) media = media.viewOnceMessageV2.message;
	if (media.viewOnceMessage) media = media.viewOnceMessage.message;

	if (media.imageMessage) media = media.imageMessage;
	else if (media.videoMessage) media = media.videoMessage;
	else if (media.stickerMessage) media = media.stickerMessage;
	else if (media.documentMessage) media = media.documentMessage;
	else if (media.audioMessage) media = media.audioMessage;

	// Validasi mediaKey
	if (!media.mediaKey) {
		throw new Error("Kunci media (mediaKey) kosong atau pesan media sudah kedaluwarsa dari server WhatsApp.");
	}

	// Kirim objek media langsung ke downloadContentFromMessage Baileys
	const stream = await downloadContentFromMessage(media, mediaType);
	let buffer = Buffer.from([]);
	for await (const chunk of stream) {
		buffer = Buffer.concat([buffer, chunk]);
	}
	return buffer;
}

/**
 * Menjalankan perintah FFmpeg via spawn child process
 * @param {Array<string>} args
 * @returns {Promise<void>}
 */
function runFfmpeg(args) {
	return new Promise((resolve, reject) => {
		const ffmpeg = spawn("ffmpeg", args);
		let stderr = "";

		ffmpeg.stderr.on("data", (data) => {
			stderr += data.toString();
		});

		ffmpeg.on("close", (code) => {
			if (code === 0) {
				resolve();
			} else {
				reject(new Error(`FFmpeg error (code ${code}): ${stderr}`));
			}
		});

		ffmpeg.on("error", (err) => {
			reject(new Error(`Gagal menjalankan FFmpeg: ${err.message}`));
		});
	});
}

/**
 * Konversi gambar statis (JPG/PNG) ke stiker WebP 512x512 tanpa distorsi rasio
 * @param {Buffer} inputBuffer
 * @returns {Promise<Buffer>}
 */
async function imageToWebp(inputBuffer) {
	const tmpDir = os.tmpdir();
	const inputPath = path.join(tmpDir, `in_${Date.now()}_${Math.random().toString(36).substring(7)}.png`);
	const outputPath = path.join(tmpDir, `out_${Date.now()}_${Math.random().toString(36).substring(7)}.webp`);

	try {
		await fs.promises.writeFile(inputPath, inputBuffer);
		// FFmpeg filter: crop tengah ke kotak 1:1 lalu scale 512x512 (tanpa black bar)
		const filter = "scale=512:512:force_original_aspect_ratio=increase:flags=lanczos,crop=512:512";

		await runFfmpeg(["-y", "-i", inputPath, "-vf", filter, outputPath]);

		const result = await fs.promises.readFile(outputPath);
		return result;
	} finally {
		if (fs.existsSync(inputPath)) await fs.promises.unlink(inputPath).catch(() => {});
		if (fs.existsSync(outputPath)) await fs.promises.unlink(outputPath).catch(() => {});
	}
}

/**
 * Konversi video / GIF ke stiker bergerak (Animated WebP)
 * @param {Buffer} inputBuffer
 * @param {number} maxDuration - Durasi maksimal dalam detik (default 9 detik)
 * @returns {Promise<Buffer>}
 */
async function videoToWebp(inputBuffer, maxDuration = 9) {
	const tmpDir = os.tmpdir();
	const inputPath = path.join(tmpDir, `vid_in_${Date.now()}_${Math.random().toString(36).substring(7)}.mp4`);
	const outputPath = path.join(tmpDir, `vid_out_${Date.now()}_${Math.random().toString(36).substring(7)}.webp`);

	try {
		await fs.promises.writeFile(inputPath, inputBuffer);

		// Filter animasi: crop tengah ke kotak 1:1, scale 512x512, fps 15, max 9 detik, loop 0
		const filter = "scale=512:512:force_original_aspect_ratio=increase,crop=512:512,fps=15";
		await runFfmpeg([
			"-y",
			"-i",
			inputPath,
			"-vf",
			filter,
			"-loop",
			"0",
			"-ss",
			"00:00:00",
			"-t",
			`00:00:0${Math.min(maxDuration, 9)}`,
			"-preset",
			"default",
			"-an",
			outputPath,
		]);

		const result = await fs.promises.readFile(outputPath);
		return result;
	} finally {
		if (fs.existsSync(inputPath)) await fs.promises.unlink(inputPath).catch(() => {});
		if (fs.existsSync(outputPath)) await fs.promises.unlink(outputPath).catch(() => {});
	}
}

/**
 * Konversi stiker WebP kembali ke format gambar PNG
 * @param {Buffer} webpBuffer
 * @returns {Promise<Buffer>}
 */
async function webpToImage(webpBuffer) {
	const tmpDir = os.tmpdir();
	const inputPath = path.join(tmpDir, `stk_in_${Date.now()}_${Math.random().toString(36).substring(7)}.webp`);
	const outputPath = path.join(tmpDir, `stk_out_${Date.now()}_${Math.random().toString(36).substring(7)}.png`);

	try {
		await fs.promises.writeFile(inputPath, webpBuffer);
		await runFfmpeg(["-y", "-i", inputPath, "-vframes", "1", outputPath]);
		const result = await fs.promises.readFile(outputPath);
		return result;
	} finally {
		if (fs.existsSync(inputPath)) await fs.promises.unlink(inputPath).catch(() => {});
		if (fs.existsSync(outputPath)) await fs.promises.unlink(outputPath).catch(() => {});
	}
}

/**
 * Menyuntikkan EXIF Metadata (Pack Name & Author) ke file WebP Stiker WhatsApp
 * @param {Buffer} webpBuffer - Buffer stiker webp mentah
 * @param {string} packname - Nama paket stiker
 * @param {string} author - Nama pembuat stiker
 * @returns {Promise<Buffer>} - Buffer stiker dengan EXIF WhatsApp
 */
async function addExif(webpBuffer, packname = "AutoBot Sticker", author = "Whiskeysockets Baileys") {
	try {
		const img = new webp.Image();
		await img.load(webpBuffer);

		// Format metadata JSON yang dipahami oleh WhatsApp
		const json = {
			"sticker-pack-id": `com.whiskeysockets.baileys.${Date.now()}`,
			"sticker-pack-name": packname,
			"sticker-pack-publisher": author,
			emojis: ["🤖", "✨"],
		};

		// Header EXIF TIFF Little-Endian spesifik WhatsApp
		const exifAttr = Buffer.from([
			0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00, 0x00, 0x00,
			0x16, 0x00, 0x00, 0x00,
		]);

		const jsonBuff = Buffer.from(JSON.stringify(json), "utf-8");
		const exif = Buffer.concat([exifAttr, jsonBuff]);
		exif.writeUIntLE(jsonBuff.length, 14, 4);

		img.exif = exif;
		return await img.save(null);
	} catch (err) {
		// Jika node-webpmux gagal, kembalikan buffer webp asli
		console.warn("Peringatan: Gagal menambahkan EXIF ke stiker:", err.message);
		return webpBuffer;
	}
}
/**
 * Membuat stiker meme dengan teks atas dan bawah menggunakan FFmpeg
 * @param {Buffer} inputBuffer - Buffer gambar (PNG/JPG)
 * @param {string} topText - Teks bagian atas
 * @param {string} bottomText - Teks bagian bawah
 * @returns {Promise<Buffer>} - Buffer WebP stiker meme 512x512
 */
async function createMemeSticker(inputBuffer, topText = "", bottomText = "") {
	const tmpDir = os.tmpdir();
	const inputPath = path.join(tmpDir, `smeme_in_${Date.now()}_${Math.random().toString(36).substring(7)}.png`);
	const outputPath = path.join(tmpDir, `smeme_out_${Date.now()}_${Math.random().toString(36).substring(7)}.webp`);

	try {
		await fs.promises.writeFile(inputPath, inputBuffer);

		const fontFile = path.resolve(__dirname, "../assets/impact.ttf").replace(/\\/g, "/").replace(":", "\\:");

		function wrapText(str, maxChars = 20) {
			if (!str) return "";
			const words = str.trim().split(/\s+/);
			const lines = [];
			let currentLine = "";
			for (const word of words) {
				if ((currentLine + " " + word).trim().length <= maxChars) {
					currentLine = (currentLine + " " + word).trim();
				} else {
					if (currentLine) lines.push(currentLine);
					currentLine = word;
				}
			}
			if (currentLine) lines.push(currentLine);
			return lines.join("\n");
		}

		function escapeDrawText(text) {
			return text
				.replace(/\\/g, "\\\\")
				.replace(/'/g, "\\'")
				.replace(/:/g, "\\:")
				.replace(/%/g, "%%");
		}

		const filters = [
			"scale=512:512:force_original_aspect_ratio=increase:flags=lanczos,crop=512:512",
		];

		function getFontSettings(str) {
			const len = str.length;
			if (len <= 10) return { size: 60, border: 6, wrap: 12 };
			if (len <= 20) return { size: 52, border: 5, wrap: 15 };
			if (len <= 35) return { size: 44, border: 4, wrap: 18 };
			return { size: 38, border: 4, wrap: 22 };
		}

		if (topText && topText.trim()) {
			const settings = getFontSettings(topText.trim());
			const cleanTop = escapeDrawText(wrapText(topText.trim().toUpperCase(), settings.wrap));
			filters.push(
				`drawtext=fontfile='${fontFile}':text='${cleanTop}':fontcolor=white:bordercolor=black:borderw=${settings.border}:fontsize=${settings.size}:line_spacing=4:x=(w-text_w)/2:y=15`
			);
		}

		if (bottomText && bottomText.trim()) {
			const settings = getFontSettings(bottomText.trim());
			const cleanBottom = escapeDrawText(wrapText(bottomText.trim().toUpperCase(), settings.wrap));
			filters.push(
				`drawtext=fontfile='${fontFile}':text='${cleanBottom}':fontcolor=white:bordercolor=black:borderw=${settings.border}:fontsize=${settings.size}:line_spacing=4:x=(w-text_w)/2:y=h-text_h-15`
			);
		}
		await runFfmpeg(["-y", "-i", inputPath, "-vf", filters.join(","), outputPath]);

		const result = await fs.promises.readFile(outputPath);
		return result;
	} finally {
		if (fs.existsSync(inputPath)) await fs.promises.unlink(inputPath).catch(() => {});
		if (fs.existsSync(outputPath)) await fs.promises.unlink(outputPath).catch(() => {});
	}
}
/**
 * Membuat stiker teks Brat (latar putih, huruf kecil hitam blur khas tren meme)
 * @param {string} text - Teks brat
 * @returns {Promise<Buffer>} - Buffer WebP stiker 512x512
 */
async function createBratSticker(text) {
	const clean = text.trim();
	const tmpDir = os.tmpdir();
	const outputPath = path.join(tmpDir, `brat_${Date.now()}_${Math.random().toString(36).substring(7)}.webp`);

	try {
		const fontFile = path.resolve(__dirname, "../assets/arial.ttf").replace(/\\/g, "/").replace(":", "\\:");

		function formatBratLines(str) {
			if (str.includes("\n")) {
				return str.split("\n").map((l) => l.trim().toLowerCase()).filter(Boolean);
			}

			const words = str.trim().toLowerCase().split(/\s+/);
			if (words.length <= 1) return [words[0] || ""];
			if (words.length === 2) {
				return [words[0], words[1]];
			}
			if (words.length === 3) {
				const lA = [words.slice(0, 2).join(" "), words[2]];
				const lB = [words[0], words[1], words[2]];
				const maxA = Math.max(...lA.map((l) => l.length));
				const maxB = Math.max(...lB.map((l) => l.length));
				const sA = Math.min(485 / (maxA * 0.45), 475 / (2 * 1.2));
				const sB = Math.min(485 / (maxB * 0.45), 475 / (3 * 1.2));
				return sB * 3 >= sA * 2 ? lB : lA;
			}
			if (words.length === 4) {
				const lA = [words.slice(0, 2).join(" "), words.slice(2).join(" ")];
				const lB = [words[0], words.slice(1, 3).join(" "), words[3]];
				const maxA = Math.max(...lA.map((l) => l.length));
				const maxB = Math.max(...lB.map((l) => l.length));
				const sA = Math.min(485 / (maxA * 0.45), 475 / (2 * 1.2));
				const sB = Math.min(485 / (maxB * 0.45), 475 / (3 * 1.2));
				return sB * 3 >= sA * 2 ? lB : lA;
			}
			if (words.length === 5) {
				return [words.slice(0, 2).join(" "), words.slice(2, 4).join(" "), words[4]];
			}

			const lines = [];
			let curWords = [];
			for (const w of words) {
				const cand = [...curWords, w].join(" ");
				if (curWords.length < 2 && cand.length <= 10) {
					curWords.push(w);
				} else {
					if (curWords.length > 0) lines.push(curWords.join(" "));
					curWords = [w];
				}
			}
			if (curWords.length > 0) lines.push(curWords.join(" "));
			return lines;
		}

		function estimateLineWidth(line) {
			let w = 0;
			for (const ch of line) {
				if ("mwMW".includes(ch)) w += 0.85;
				else if ("iltjfr .,:;!|/".includes(ch)) w += 0.32;
				else if (ch >= "A" && ch <= "Z") w += 0.72;
				else w += 0.60;
			}
			return w;
		}

		function calculateBratFontSize(lines) {
			const maxWeightedWidth = Math.max(...lines.map((l) => estimateLineWidth(l)));
			const numLines = lines.length;

			// Batas kanvas 512px (margin kiri x=20, aman sisi kanan ~25px => batas 465px)
			const sizeFromWidth = 465 / maxWeightedWidth;
			// Batas tinggi kanvas ~460px
			const sizeFromHeight = 460 / (numLines * 1.25);

			let optimalSize = Math.floor(Math.min(sizeFromWidth, sizeFromHeight));
			return Math.max(34, Math.min(160, optimalSize));
		}

		function escapeDrawText(str) {
			return str
				.replace(/\\/g, "\\\\")
				.replace(/'/g, "\\'")
				.replace(/:/g, "\\:")
				.replace(/%/g, "%%");
		}

		const lines = formatBratLines(clean);
		const fontSize = calculateBratFontSize(lines);
		const lineSpacing = Math.max(8, Math.floor(fontSize * 0.12));
		const formattedText = escapeDrawText(lines.join("\n"));

		const filter = [
			"scale=512:512",
			`drawtext=fontfile='${fontFile}':text='${formattedText}':fontcolor=black:fontsize=${fontSize}:line_spacing=${lineSpacing}:x=20:y=(h-text_h)/2:fix_bounds=1`,
			"gblur=sigma=3.0:steps=2",
		].join(",");

		await runFfmpeg([
			"-y",
			"-f", "lavfi",
			"-i", "color=c=white:s=512x512",
			"-vf", filter,
			"-frames:v", "1",
			outputPath,
		]);

		const result = await fs.promises.readFile(outputPath);
		return result;
	} finally {
		if (fs.existsSync(outputPath)) await fs.promises.unlink(outputPath).catch(() => {});
	}
}

module.exports = {
	downloadMediaBuffer,
	imageToWebp,
	videoToWebp,
	webpToImage,
	addExif,
	createMemeSticker,
	createBratSticker,
};
