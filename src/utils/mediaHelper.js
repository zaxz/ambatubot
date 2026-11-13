const { downloadContentFromMessage } = require("@whiskeysockets/baileys");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const webp = require("node-webpmux");
const axios = require("axios");
const { loadFont } = require("./ttfFont");
const { getEmojiAssetPath } = require("./emojiAsset");
const { ensureCjkFont, segmentCjkWords, CJK_CHAR_PATTERN } = require("./cjkFont");

/**
 * Menyiapkan path agar aman dipakai di dalam opsi filter FFmpeg.
 * @param {string} filePath
 */
function escapeFilterPath(filePath) {
	return path.resolve(filePath).replace(/\\/g, "/").replace(/:/g, "\\:");
}

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
		// FFmpeg tidak bisa decode WebP animasi (chunk ANIM/ANMF dilewati), jadi ambil
		// frame pertama lewat node-webpmux lalu konversi frame statis itu ke PNG.
		let sourceBuffer = webpBuffer;
		try {
			const probe = new webp.Image();
			await probe.load(webpBuffer);
			if (probe.hasAnim && probe.frames?.length) {
				const frames = await probe.demux({ buffers: true });
				if (frames?.[0]?.length) sourceBuffer = frames[0];
			}
		} catch (e) {
			// Jika webpmux gagal, biarkan FFmpeg mencoba buffer aslinya
		}

		await fs.promises.writeFile(inputPath, sourceBuffer);
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
const MEME_CANVAS = 512;
const MEME_PADDING_X = 18;
const MEME_PADDING_Y = 14;
const MEME_CONTENT_W = MEME_CANVAS - MEME_PADDING_X * 2;
const MEME_MAX_FONT = 112;
const MEME_MIN_FONT = 22;
const MEME_INK_HEIGHT_EM = 0.824; // tinggi tinta huruf kapital Impact
const MEME_FONT = path.resolve(__dirname, "../assets/impact.ttf");

/**
 * Membagi kata menjadi tepat `lineCount` baris dengan lebar baris paling seimbang.
 * @returns {{groups: Array<Array<string>>, maxWidthEm: number}|null}
 */
function splitBalancedWords(words, prefix, spaceEm, lineCount) {
	const total = words.length;
	const lineWidthEm = (start, end) => prefix[end] - prefix[start] + spaceEm * (end - start - 1);

	let previous = new Array(total + 1).fill(Number.POSITIVE_INFINITY);
	let previousMax = new Array(total + 1).fill(0);
	const backtracks = [];
	previous[0] = 0;

	for (let k = 1; k <= lineCount; k++) {
		const current = new Array(total + 1).fill(Number.POSITIVE_INFINITY);
		const currentMax = new Array(total + 1).fill(0);
		const cut = new Array(total + 1).fill(-1);

		for (let end = k; end <= total; end++) {
			for (let start = k - 1; start < end; start++) {
				if (previous[start] === Number.POSITIVE_INFINITY) continue;
				const width = lineWidthEm(start, end);
				const cost = previous[start] + width * width;
				if (cost < current[end] - 1e-9) {
					current[end] = cost;
					currentMax[end] = Math.max(previousMax[start], width);
					cut[end] = start;
				}
			}
		}

		backtracks.push(cut);
		previous = current;
		previousMax = currentMax;
	}

	const maxWidthEm = previousMax[total];
	if (!Number.isFinite(maxWidthEm)) return null;

	const groups = [];
	let end = total;
	for (let k = lineCount; k >= 1; k--) {
		const start = backtracks[k - 1][end];
		groups.push(words.slice(start, end));
		end = start;
	}
	groups.reverse();

	return { groups, maxWidthEm };
}

/**
 * Menggabungkan metrik font utama dan font fallback CJK per karakter.
 */
function makeFallbackMetricView(primaryFont, primaryPath, fallbackFont = null, fallbackPath = null) {
	const resolveChar = (char) => {
		if (primaryFont.hasGlyph(char)) return { font: primaryFont, path: primaryPath };
		if (fallbackFont && fallbackFont.hasGlyph(char)) return { font: fallbackFont, path: fallbackPath };
		return null;
	};
	return {
		hasGlyph: (char) => Boolean(resolveChar(char)),
		resolveChar,
		advanceEm: (char) => {
			const hit = resolveChar(char);
			return hit ? hit.font.advanceEm(char) : 0;
		},
		advancePx: (char, fontSize) => {
			const hit = resolveChar(char);
			return hit ? hit.font.advancePx(char, fontSize) : 0;
		},
		measureEm: (str) => {
			let total = 0;
			for (const ch of str) {
				const hit = resolveChar(ch);
				if (hit) total += hit.font.advanceEm(ch);
			}
			return total;
		},
		measurePx: (str, fontSize) => {
			let total = 0;
			for (const ch of str) {
				const hit = resolveChar(ch);
				if (hit) total += hit.font.advancePx(ch, fontSize);
			}
			return total;
		},
	};
}

/**
 * Menata satu bagian teks meme (atas/bawah) dengan font sebesar mungkin
 * yang masih muat di lebar kanvas dan batas tinggi slot.
 */
function planMemeSlot(font, rawText, slotMaxH) {
	if (!rawText || !rawText.trim()) return null;

	const cleaned = [...String(rawText).toUpperCase()]
		.filter((char) => /\s/.test(char) || font.hasGlyph(char))
		.join("");

	const manualLines = cleaned
		.split("\n")
		.map((line) => line.replace(/\s+/g, " ").trim())
		.filter(Boolean);

	if (manualLines.length === 0) return null;

	const sizeFor = (lineCount, maxWidthEm) => {
		const fitW = MEME_CONTENT_W / Math.max(0.5, maxWidthEm + 0.22);
		const fitH = slotMaxH / (lineCount * 1.004 + (lineCount - 1) * 0.05);
		return Math.max(MEME_MIN_FONT, Math.min(MEME_MAX_FONT, Math.round(Math.min(fitW, fitH))));
	};

	let lines;
	let fontSize;

	if (manualLines.length > 1) {
		lines = manualLines;
		const maxWidthEm = Math.max(...lines.map((line) => font.measureEm(line)));
		fontSize = sizeFor(lines.length, maxWidthEm);
	} else {
		const words = manualLines[0].split(" ").flatMap((w) =>
			CJK_CHAR_PATTERN.test(w) ? segmentCjkWords(w) : [w]
		);
		const spaceEm = font.advanceEm(" ");
		const prefix = new Array(words.length + 1).fill(0);
		for (let i = 0; i < words.length; i++) prefix[i + 1] = prefix[i] + font.measureEm(words[i]);

		let best = null;
		const maxLines = Math.min(words.length, 4);
		for (let count = 1; count <= maxLines; count++) {
			const split = splitBalancedWords(words, prefix, spaceEm, count);
			if (!split) continue;
			const fs = sizeFor(count, split.maxWidthEm);
			// Pertahankan 1 baris kecuali memecah baris membuat huruf jauh lebih besar (>18% atau 1 baris <64px)
			if (!best || fs > best.fontSize * 1.18 || (best.fontSize < 64 && fs > best.fontSize + 1)) {
				const joinedLines = split.groups.map((group) => {
					let out = "";
					for (let gi = 0; gi < group.length; gi++) {
						const prev = group[gi - 1];
						const cur = group[gi];
						const bothCjk = prev && CJK_CHAR_PATTERN.test(prev) && CJK_CHAR_PATTERN.test(cur);
						out += (gi > 0 && !bothCjk ? " " : "") + cur;
					}
					return out;
				});
				best = { lines: joinedLines, fontSize: fs };
			}
		}

		lines = best.lines;
		fontSize = best.fontSize;
	}

	const border = Math.max(4, Math.min(10, Math.round(fontSize * 0.095)));
	const inkH = Math.round(fontSize * MEME_INK_HEIGHT_EM);
	const lineVisualH = inkH + border * 2;
	const lineGap = Math.max(4, Math.round(fontSize * 0.05));
	const lineStep = lineVisualH + lineGap;
	const totalH = lines.length * lineVisualH + (lines.length - 1) * lineGap;

	return { lines, fontSize, border, lineStep, totalH };
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
	const id = `${Date.now()}_${Math.random().toString(36).substring(7)}`;
	const inputPath = path.join(tmpDir, `smeme_in_${id}.png`);
	const outputPath = path.join(tmpDir, `smeme_out_${id}.webp`);
	const textDir = path.join(tmpDir, `smeme_txt_${id}`);

	try {
		await fs.promises.writeFile(inputPath, inputBuffer);
		await fs.promises.mkdir(textDir, { recursive: true });

		const primaryFont = loadFont(MEME_FONT);
		const combined = `${topText || ""}${bottomText || ""}`;
		const needsCjk = [...combined].some((ch) => !/\s/.test(ch) && !primaryFont.hasGlyph(ch));
		const cjkFontPath = needsCjk ? await ensureCjkFont().catch(() => null) : null;
		const cjkFont = cjkFontPath ? loadFont(cjkFontPath) : null;
		const metricFont = makeFallbackMetricView(primaryFont, MEME_FONT, cjkFont, cjkFontPath);

		const hasTop = Boolean(topText && topText.trim());
		const hasBottom = Boolean(bottomText && bottomText.trim());
		const slotMaxH = hasTop && hasBottom ? 195 : 225;

		const topSlot = planMemeSlot(metricFont, topText, slotMaxH);
		const bottomSlot = planMemeSlot(metricFont, bottomText, slotMaxH);

		const filters = [
			"scale=512:512:force_original_aspect_ratio=increase:flags=lanczos,crop=512:512",
		];

		let lineIdx = 0;
		const pushSlotLines = async (slot, startY) => {
			for (let i = 0; i < slot.lines.length; i++) {
				const lineText = slot.lines[i];
				const y = Math.round(startY + slot.border + i * slot.lineStep);
				const totalW = metricFont.measurePx(lineText, slot.fontSize);
				let penX = Math.round((MEME_CANVAS - totalW) / 2);

				let run = "";
				let runPath = MEME_FONT;
				let runFont = primaryFont;

				const flushMemeRun = async () => {
					if (!run) return;
					const lineFile = path.join(textDir, `l${lineIdx++}.txt`);
					await fs.promises.writeFile(lineFile, run, "utf8");
					filters.push(
						`drawtext=fontfile='${escapeFilterPath(runPath)}':textfile='${escapeFilterPath(lineFile)}':expansion=none:fontcolor=white:bordercolor=black:borderw=${slot.border}:fontsize=${slot.fontSize}:x=${Math.round(penX)}:y=${y}`
					);
					for (const ch of run) {
						if (runFont.hasGlyph(ch)) penX += runFont.advancePx(ch, slot.fontSize);
					}
					run = "";
				};

				for (const ch of lineText) {
					let nextFont = primaryFont;
					let nextPath = MEME_FONT;
					if (/\s/.test(ch) && run && runFont.hasGlyph(ch)) {
						nextFont = runFont;
						nextPath = runPath;
					} else if (!primaryFont.hasGlyph(ch) && cjkFont && cjkFont.hasGlyph(ch)) {
						nextFont = cjkFont;
						nextPath = cjkFontPath;
					}
					if (run && nextPath !== runPath) await flushMemeRun();
					runFont = nextFont;
					runPath = nextPath;
					run += ch;
				}
				await flushMemeRun();
			}
		};

		if (topSlot) {
			await pushSlotLines(topSlot, MEME_PADDING_Y);
		}
		if (bottomSlot) {
			await pushSlotLines(bottomSlot, MEME_CANVAS - MEME_PADDING_Y - bottomSlot.totalH);
		}

		await runFfmpeg(["-y", "-i", inputPath, "-vf", filters.join(","), outputPath]);

		return await fs.promises.readFile(outputPath);
	} finally {
		if (fs.existsSync(inputPath)) await fs.promises.unlink(inputPath).catch(() => {});
		if (fs.existsSync(outputPath)) await fs.promises.unlink(outputPath).catch(() => {});
		await fs.promises.rm(textDir, { recursive: true, force: true }).catch(() => {});
	}
}
/**
 * Batas kanvas stiker brat, font, dan aturan tata letaknya.
 */
const BRAT_CANVAS = 512;
const BRAT_PADDING_X = 28;
const BRAT_PADDING_Y = 30;
const BRAT_CONTENT_W = BRAT_CANVAS - BRAT_PADDING_X * 2;
const BRAT_CONTENT_H = BRAT_CANVAS - BRAT_PADDING_Y * 2;
const BRAT_LINE_PITCH_EM = 1.0; // jarak antar baris (1 em)
const BRAT_MIN_SQUEEZE = 0.82; // kondensasi horizontal maksimal agar teks tetap terbaca
const BRAT_MAX_LINES = 30;
const BRAT_MIN_FONT_SIZE = 12;
const BRAT_MAX_FONT_SIZE = 480;
const BRAT_BLUR_SIGMA = 3; // tingkat blur teks (piksel pada kanvas 512)
const BRAT_TEXT_FONT = path.resolve(__dirname, "../assets/arial.ttf");

// Emoji digambar sebagai PNG berwarna (FFmpeg hanya bisa menggambar outline font emoji,
// hasilnya hitam-putih), ukurannya mengikuti skala font yang sedang dipakai.
const BRAT_EMOJI_HEIGHT_EM = 0.95; // tinggi tinta emoji
const BRAT_EMOJI_MAX_WIDTH_EM = 1.15; // batas lebar tinta emoji (mis. bendera)
const BRAT_EMOJI_GAP_EM = 0.1; // jarak antar emoji
const BRAT_EMOJI_CENTER_EM = 0.26; // pusat tinta emoji terhadap baseline
const BRAT_EMOJI_FALLBACK_EM = 0.9; // dipakai bila ukuran tinta gagal diukur
const emojiInkCache = new Map();
const BRAT_TEXT_VARIATION = /\uFE0E/g;
const BRAT_EMOJI_PATTERN = /\p{Extended_Pictographic}|\p{Regional_Indicator}|[\u2600-\u27BF]|\u20E3/u;

const graphemeSegmenter =
	typeof Intl !== "undefined" && Intl.Segmenter ? new Intl.Segmenter("en", { granularity: "grapheme" }) : null;

/**
 * Mengukur kotak tinta (bagian bergambar) sebuah PNG emoji.
 * @returns {Promise<{x: number, y: number, w: number, h: number}|null>}
 */
function probeEmojiInk(filePath) {
	if (emojiInkCache.has(filePath)) return Promise.resolve(emojiInkCache.get(filePath));

	return new Promise((resolve) => {
		const ffmpeg = spawn("ffmpeg", [
			"-hide_banner",
			"-i", filePath,
			"-vf", "format=rgba,alphaextract,bbox=min_val=16",
			"-frames:v", "1",
			"-f", "null", "-",
		]);

		let stderr = "";
		const finish = (result) => {
			emojiInkCache.set(filePath, result);
			resolve(result);
		};

		ffmpeg.stderr.on("data", (data) => {
			stderr += data.toString();
		});
		ffmpeg.on("error", () => finish(null));
		ffmpeg.on("close", () => {
			const match = stderr.match(/x1:(\d+)\s+x2:(\d+)\s+y1:(\d+)\s+y2:(\d+)/);
			if (!match) return finish(null);
			const [x1, x2, y1, y2] = match.slice(1).map(Number);
			if (x2 <= x1 || y2 <= y1) return finish(null);
			finish({ x: x1, y: y1, w: x2 - x1 + 1, h: y2 - y1 + 1 });
		});
	});
}

/** Memecah teks menjadi satu karakter utuh (emoji gabungan tetap satu bagian). */
function tokenize(text) {
	if (graphemeSegmenter) {
		return Array.from(graphemeSegmenter.segment(text), (part) => part.segment);
	}
	return [...text];
}

/**
 * Menggabungkan font teks dan daftar emoji berwarna menjadi satu objek metrik,
 * sehingga tata letak bisa menghitung lebar/tinggi tanpa peduli jenis karakternya.
 * @param {Map<string, string>} emojiAssets - token emoji → path PNG
 */
function createBratTypography(emojiAssets, cjkFontInfo = null) {
	const textFont = loadFont(BRAT_TEXT_FONT);
	const cjkFont = cjkFontInfo?.font || null;
	const cjkFontPath = cjkFontInfo?.path || null;

	const fontForChar = (char) => {
		if (textFont.hasGlyph(char)) return textFont;
		if (cjkFont && cjkFont.hasGlyph(char)) return cjkFont;
		return null;
	};

	const fontPathForChar = (char) => {
		if (textFont.hasGlyph(char)) return BRAT_TEXT_FONT;
		if (cjkFont && cjkFont.hasGlyph(char)) return cjkFontPath;
		return null;
	};

	const isEmoji = (token) => emojiAssets.has(token);
	const isText = (token) => [...token].every((char) => /\s/.test(char) || Boolean(fontForChar(char)));

	return {
		isEmoji,
		isText,
		fontForChar,
		fontPathForChar,
		textFonts: () => textFont,
		assetOf: (token) => emojiAssets.get(token),
		advanceEm(token) {
			if (isEmoji(token)) return emojiAssets.get(token).advanceEm;

			let total = 0;
			for (const char of token) {
				const f = fontForChar(char);
				if (f) total += f.advanceEm(char);
			}
			return total;
		},
		advancePx(token, fontSize) {
			if (isEmoji(token)) return Math.round(emojiAssets.get(token).advanceEm * fontSize);

			let total = 0;
			for (const char of token) {
				const f = fontForChar(char);
				if (f) total += f.advancePx(char, fontSize);
			}
			return total;
		},
		measureEm(text) {
			let total = 0;
			for (const token of tokenize(text)) total += this.advanceEm(token);
			return total;
		},
		measurePx(text, fontSize) {
			let total = 0;
			for (const token of tokenize(text)) total += this.advancePx(token, fontSize);
			return total;
		},
		inkOf(text) {
			let ascent = 0;
			let descent = 0;

			for (const token of tokenize(text)) {
				if (isEmoji(token)) {
					// Emoji dipusatkan pada tinggi huruf kecil, sama seperti saat digambar
					const height = emojiAssets.get(token).heightEm;
					const emojiAscent = BRAT_EMOJI_CENTER_EM + height / 2;
					const emojiDescent = Math.max(0, height / 2 - BRAT_EMOJI_CENTER_EM);
					if (emojiAscent > ascent) ascent = emojiAscent;
					if (emojiDescent > descent) descent = emojiDescent;
					continue;
				}

				for (const char of token) {
					const f = fontForChar(char);
					if (!f) continue;
					const box = f.inkEm(char);
					if (box.ascent > ascent) ascent = box.ascent;
					if (box.descent > descent) descent = box.descent;
				}
			}

			return { ascent, descent };
		},
	};
}

/**
 * Mencari pembagian baris paling seimbang untuk tiap jumlah baris,
 * lalu memilih jumlah baris yang menghasilkan huruf terbesar.
 * @returns {{lines: Array<Array<string>>, maxWidthEm: number, fontSize: number}}
 */
function planBratLines(typo, words) {
	const total = words.length;
	const spaceEm = typo.advanceEm(" ");
	const prefix = new Array(total + 1).fill(0);
	for (let i = 0; i < total; i++) prefix[i + 1] = prefix[i] + typo.measureEm(words[i]);

	const lineWidthEm = (start, end) => prefix[end] - prefix[start] + spaceEm * (end - start - 1);

	let best = null;
	const limit = Math.min(total, BRAT_MAX_LINES);

	for (let lines = 1; lines <= limit; lines++) {
		const split = splitBalancedWords(words, prefix, spaceEm, lines);
		if (!split) continue;

		const { groups, maxWidthEm } = split;
		const fontSize = Math.min(
			BRAT_CONTENT_H / ((lines - 1) * BRAT_LINE_PITCH_EM + blockInkEm(typo, words)),
			BRAT_CONTENT_W / maxWidthEm / BRAT_MIN_SQUEEZE
		);

		if (!best || fontSize > best.fontSize + 0.01) {
			best = { lines: groups, maxWidthEm, fontSize };
		}
	}

	return best;
}

/** Tinggi tinta total (ascent + descent) dari seluruh teks dalam em. */
function blockInkEm(typo, words) {
	let ascent = 0;
	let descent = 0;
	for (const word of words) {
		const ink = typo.inkOf(word);
		if (ink.ascent > ascent) ascent = ink.ascent;
		if (ink.descent > descent) descent = ink.descent;
	}
	return Math.max(0.6, ascent + descent);
}

/**
 * Menyiapkan aset emoji berwarna beserta ukuran tinta aslinya.
 * @returns {Promise<Map<string, {path: string, box: Object|null, widthEm: number, heightEm: number, advanceEm: number}>>}
 */
async function collectEmojiAssets(tokens) {
	const unique = [...new Set(tokens)];
	const assets = new Map();

	await Promise.all(
		unique.map(async (token) => {
			const filePath = await getEmojiAssetPath(token).catch(() => null);
			if (!filePath) return;

			const box = await probeEmojiInk(filePath);

			let widthEm = BRAT_EMOJI_FALLBACK_EM;
			let heightEm = BRAT_EMOJI_FALLBACK_EM;

			if (box) {
				const aspect = box.w / box.h;
				if (aspect > BRAT_EMOJI_MAX_WIDTH_EM / BRAT_EMOJI_HEIGHT_EM) {
					widthEm = BRAT_EMOJI_MAX_WIDTH_EM;
					heightEm = widthEm / aspect;
				} else {
					heightEm = BRAT_EMOJI_HEIGHT_EM;
					widthEm = heightEm * aspect;
				}
			}

			assets.set(token, { path: filePath, box, widthEm, heightEm, advanceEm: widthEm + BRAT_EMOJI_GAP_EM });
		})
	);

	return assets;
}

/**
 * Menyiapkan teks, font, dan aset emoji berwarna untuk rendering Brat.
 */
async function prepareBratInput(text) {
	const prepared = String(text).replace(BRAT_TEXT_VARIATION, "");
	const baseFont = loadFont(BRAT_TEXT_FONT);
	const rawTokens = tokenize(prepared);

	// Emoji (yang tidak ada di font teks) diambil dulu sebagai gambar berwarna Apple/iPhone
	const emojiCandidates = rawTokens.filter(
		(token) =>
			BRAT_EMOJI_PATTERN.test(token) && ![...token].every((char) => baseFont.hasGlyph(char))
	);
	const emojiAssets = await collectEmojiAssets(emojiCandidates);

	// Cek apakah butuh font fallback CJK (Jepang / Mandarin)
	const needsCjk = rawTokens.some(
		(token) => !/\s/.test(token) && !emojiAssets.has(token) && ![...token].every((c) => baseFont.hasGlyph(c))
	);
	const cjkPath = needsCjk ? await ensureCjkFont().catch(() => null) : null;
	const cjkFontInfo = cjkPath ? { path: cjkPath, font: loadFont(cjkPath) } : null;
	const typo = createBratTypography(emojiAssets, cjkFontInfo);

	// Sisakan hanya karakter yang bisa digambar: teks (di-lowercase), emoji yang asetnya tersedia
	const kept = rawTokens
		.map((token) => (typo.isEmoji(token) ? token : token.toLowerCase()))
		.filter((token) => /\s/.test(token) || typo.isText(token) || typo.isEmoji(token));

	const forcedLines = kept
		.join("")
		.split("\n")
		.map((line) => line.replace(/\s+/g, " ").trim())
		.filter(Boolean);

	if (forcedLines.length === 0) {
		throw new Error("Teks brat tidak berisi huruf yang didukung font");
	}

	return { forcedLines, typo };
}

/**
 * Merender satu frame WebP 512x512 bergaya Brat dari baris teks yang sudah disiapkan.
 * @param {Array<string>} forcedLines
 * @param {Object} typo
 * @param {number} quality
 * @returns {Promise<Buffer>}
 */
async function renderBratFrame(forcedLines, typo, quality = 92) {
	const splitBratLineWords = (line) =>
		line.split(" ").flatMap((w) => (CJK_CHAR_PATTERN.test(w) ? segmentCjkWords(w) : [w]));
	const words = forcedLines.flatMap(splitBratLineWords);
	const inkTotalEm = blockInkEm(typo, words);

	// Tentukan pembagian baris: hormati enter manual, selain itu cari yang paling besar
	const planned =
		forcedLines.length > 1
			? {
					lines: forcedLines.map(splitBratLineWords),
					maxWidthEm: Math.max(...forcedLines.map((line) => typo.measureEm(line))),
			  }
			: planBratLines(typo, words);
	const lines = planned.lines;
	const inkAscentEm = Math.max(...words.map((word) => typo.inkOf(word).ascent));

	// Ukuran font: penuhi tinggi kanvas, jangan sampai melebar keluar batas horizontal
	const fitHeight = BRAT_CONTENT_H / ((lines.length - 1) * BRAT_LINE_PITCH_EM + inkTotalEm);
	const fitWidth = BRAT_CONTENT_W / planned.maxWidthEm;
	const fontSize = Math.max(
		BRAT_MIN_FONT_SIZE,
		Math.min(BRAT_MAX_FONT_SIZE, Math.round(Math.min(fitHeight, fitWidth / BRAT_MIN_SQUEEZE)))
	);

	const spacePx = typo.advancePx(" ", fontSize);
	const widthCache = new Map();
	const wordWidth = (word) => {
		if (!widthCache.has(word)) widthCache.set(word, typo.measurePx(word, fontSize));
		return widthCache.get(word);
	};

	const lineWidths = lines.map(
		(line) => line.reduce((sum, word) => sum + wordWidth(word), 0) + spacePx * (line.length - 1)
	);
	const widestLine = Math.max(...lineWidths);

	// Bila teks terlalu lebar, kondensasi horizontal (mirip font condensed) lalu ratakan
	const squeeze = Math.max(0.6, Math.min(1, BRAT_CONTENT_W / widestLine));
	const canvasWidth = Math.round(BRAT_CANVAS / squeeze);
	const scaleX = BRAT_CANVAS / canvasWidth;
	const contentWidth = BRAT_CONTENT_W / scaleX;
	const marginX = BRAT_PADDING_X / scaleX;

	// Posisi vertikal: semua baris & potongan kata memakai baseline yang sama
	const pitch = fontSize * BRAT_LINE_PITCH_EM;
	const inkTop = (BRAT_CANVAS - ((lines.length - 1) * pitch + inkTotalEm * fontSize)) / 2;
	const firstBaseline = inkTop + inkAscentEm * fontSize;

	const tmpDir = os.tmpdir();
	const outputPath = path.join(tmpDir, `brat_${Date.now()}_${Math.random().toString(36).substring(7)}.webp`);
	const textDir = path.join(tmpDir, `brat_txt_${Date.now()}_${Math.random().toString(36).substring(7)}`);

	try {
		await fs.promises.mkdir(textDir, { recursive: true });

		const textFiles = new Map();
		const writeTextFile = async (content) => {
			if (textFiles.has(content)) return textFiles.get(content);
			const file = path.join(textDir, `t${textFiles.size}.txt`);
			await fs.promises.writeFile(file, content, "utf8");
			textFiles.set(content, file);
			return file;
		};

		const draws = [];
		const overlays = [];

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const lineWidth = line.reduce((sum, word) => sum + wordWidth(word), 0);
			const gap = line.length > 1 ? Math.max(0, (contentWidth - lineWidth) / (line.length - 1)) : 0;
			const baseline = firstBaseline + i * pitch;

			let penX = marginX;
			for (const word of line) {
				let textRun = "";
				let textRunFontPath = BRAT_TEXT_FONT;

				const flushRun = async () => {
					if (!textRun) return;
					const file = await writeTextFile(textRun);
					// drawtext menempelkan y ke puncak tinta teks, jadi tinggi tiap potongan
					// dihitung sendiri agar baseline semua potongan sejajar
					const y = Math.round(baseline - typo.inkOf(textRun).ascent * fontSize);
					draws.push(
						`drawtext=fontfile='${escapeFilterPath(textRunFontPath)}':textfile='${escapeFilterPath(file)}':expansion=none:fontcolor=black:fontsize=${fontSize}:x=${Math.round(penX)}:y=${y}`
					);
					penX += typo.measurePx(textRun, fontSize);
					textRun = "";
				};

				for (const token of tokenize(word)) {
					if (typo.isEmoji(token)) {
						await flushRun();
						const asset = typo.assetOf(token);
						const advance = typo.advancePx(token, fontSize);
						const width = Math.max(1, Math.round(asset.widthEm * fontSize));
						const height = Math.max(1, Math.round(asset.heightEm * fontSize));

						overlays.push({
							path: asset.path,
							box: asset.box,
							x: Math.round(penX + (advance - width) / 2),
							// Emoji dipusatkan pada tinggi huruf kecil agar sejajar dengan teks
							y: Math.round(baseline - fontSize * BRAT_EMOJI_CENTER_EM - height / 2),
							width,
							height,
						});
						penX += advance;
					} else {
						for (const ch of token) {
							const chPath = /\s/.test(ch) && textRun
								? textRunFontPath
								: (typo.fontPathForChar(ch) || BRAT_TEXT_FONT);
							if (textRun && chPath !== textRunFontPath) {
								await flushRun();
							}
							textRunFontPath = chPath;
							textRun += ch;
						}
					}
				}

				await flushRun();
				penX += gap;
			}
		}

		// Susun filter: teks → tempel emoji berwarna → skala ke 512 → blur
		const graph = [`[0:v]${draws.length ? draws.join(",") : "null"}[base]`];
		let previous = "base";

		overlays.forEach((overlay, index) => {
			const crop = overlay.box
				? `crop=${overlay.box.w}:${overlay.box.h}:${overlay.box.x}:${overlay.box.y},`
				: "";
			graph.push(
				`[${index + 1}:v]${crop}scale=${overlay.width}:${overlay.height}:flags=lanczos,format=rgba[ov${index}]`
			);
			graph.push(`[${previous}][ov${index}]overlay=x=${overlay.x}:y=${overlay.y}:format=auto[b${index}]`);
			previous = `b${index}`;
		});

		graph.push(
			`[${previous}]scale=${BRAT_CANVAS}:${BRAT_CANVAS}:flags=lanczos,gblur=sigma=${BRAT_BLUR_SIGMA}:steps=2[out]`
		);

		const args = ["-y", "-f", "lavfi", "-i", `color=c=white:s=${canvasWidth}x${BRAT_CANVAS}`];
		for (const overlay of overlays) args.push("-i", overlay.path);
		args.push(
			"-filter_complex", graph.join(";"),
			"-map", "[out]",
			"-frames:v", "1",
			"-c:v", "libwebp",
			"-quality", String(quality),
			"-compression_level", "6",
			outputPath
		);

		await runFfmpeg(args);

		return await fs.promises.readFile(outputPath);
	} finally {
		if (fs.existsSync(outputPath)) await fs.promises.unlink(outputPath).catch(() => {});
		await fs.promises.rm(textDir, { recursive: true, force: true }).catch(() => {});
	}
}

/**
 * Merender satu frame putih polos 512x512 WebP (fallback animasi 1 huruf/emoji).
 */
async function renderWhiteBratFrame() {
	const tmpPath = path.join(os.tmpdir(), `brat_blank_${Date.now()}_${Math.random().toString(36).substring(7)}.webp`);
	try {
		await runFfmpeg([
			"-y",
			"-f", "lavfi",
			"-i", `color=c=white:s=${BRAT_CANVAS}x${BRAT_CANVAS}`,
			"-frames:v", "1",
			"-c:v", "libwebp",
			"-quality", "80",
			tmpPath,
		]);
		return await fs.promises.readFile(tmpPath);
	} finally {
		if (fs.existsSync(tmpPath)) await fs.promises.unlink(tmpPath).catch(() => {});
	}
}

/**
 * Membuat stiker teks Brat (latar putih, teks hitam besar rata kanan-kiri, emoji berwarna, blur).
 * @param {string} text - Teks brat
 * @returns {Promise<Buffer>} - Buffer WebP stiker 512x512
 */
async function createBratSticker(text) {
	const { forcedLines, typo } = await prepareBratInput(text);
	return await renderBratFrame(forcedLines, typo);
}

const BRATVID_MAX_STEPS = 18;
const BRATVID_CONCURRENCY = 4;
const BRATVID_FINAL_HOLD_MS = 2000;
const BRATVID_MAX_SIZE_BYTES = 950 * 1024;

/**
 * Membuat stiker teks Brat bergerak (kata muncul bertahap kata demi kata).
 * @param {string} text - Teks brat
 * @param {number} maxDurationSeconds - Batas maksimal durasi animasi (detik)
 * @returns {Promise<Buffer>} - Buffer Animated WebP 512x512
 */
async function createBratVideoSticker(text, maxDurationSeconds = 9) {
	const { forcedLines, typo } = await prepareBratInput(text);
	const wordEntries = forcedLines.flatMap((line, lineIdx) =>
		line.split(" ").flatMap((w) => {
			const parts = CJK_CHAR_PATTERN.test(w) ? segmentCjkWords(w) : [w];
			return parts.map((word, partIdx) => ({ lineIdx, word, joinPrev: partIdx > 0 }));
		})
	);

	const buildSampledCounts = (total) => {
		const counts = [];
		if (total <= BRATVID_MAX_STEPS) {
			for (let i = 1; i <= total; i++) counts.push(i);
			return counts;
		}
		for (let s = 1; s < BRATVID_MAX_STEPS; s++) {
			const idx = Math.max(1, Math.round((s * total) / BRATVID_MAX_STEPS));
			if (counts[counts.length - 1] !== idx) counts.push(idx);
		}
		if (counts[counts.length - 1] !== total) counts.push(total);
		return counts;
	};

	// Susun daftar frame progresif (per kata, atau per karakter jika hanya 1 kata)
	const stepDescriptors = [];
	if (wordEntries.length > 1) {
		for (const count of buildSampledCounts(wordEntries.length)) {
			const byLine = new Map();
			for (const entry of wordEntries.slice(0, count)) {
				if (!byLine.has(entry.lineIdx)) byLine.set(entry.lineIdx, "");
				const prev = byLine.get(entry.lineIdx);
				byLine.set(entry.lineIdx, prev + (prev && !entry.joinPrev ? " " : "") + entry.word);
			}
			stepDescriptors.push({
				blank: false,
				lines: [...byLine.values()],
			});
		}
	} else {
		const tokens = tokenize(wordEntries[0].word);
		if (tokens.length > 1) {
			for (const count of buildSampledCounts(tokens.length)) {
				stepDescriptors.push({
					blank: false,
					lines: [tokens.slice(0, count).join("")],
				});
			}
		} else {
			stepDescriptors.push({ blank: true });
			stepDescriptors.push({ blank: false, lines: [wordEntries[0].word] });
		}
	}

	const stepCount = stepDescriptors.length;
	const maxTotalMs = Math.min(maxDurationSeconds, 9) * 1000;
	// Jeda antar kata dibuat seragam; setelah kata terakhir tampil, frame-nya
	// diduplikasi sebagai frame "diam" agar terlihat berhenti sebelum loop ulang.
	const holdMs = Math.max(800, Math.min(BRATVID_FINAL_HOLD_MS, maxTotalMs - (stepCount - 1) * 180));
	const rawStepDelay = stepCount <= 5 ? 420 : stepCount <= 10 ? 340 : Math.round(4500 / (stepCount - 1));
	const stepDelayMs = Math.max(
		180,
		Math.min(rawStepDelay, Math.floor((maxTotalMs - holdMs) / Math.max(1, stepCount - 1)))
	);

	const renderAllFrames = async (quality) => {
		const buffers = new Array(stepCount);
		let cursor = 0;
		const workers = Array.from({ length: Math.min(BRATVID_CONCURRENCY, stepCount) }, async () => {
			while (true) {
				const idx = cursor++;
				if (idx >= stepCount) break;
				const step = stepDescriptors[idx];
				buffers[idx] = step.blank
					? await renderWhiteBratFrame()
					: await renderBratFrame(step.lines, typo, quality);
			}
		});
		await Promise.all(workers);

		const frames = [];
		for (let i = 0; i < buffers.length; i++) {
			frames.push(
				await webp.Image.generateFrame({
					buffer: buffers[i],
					delay: stepDelayMs,
					blend: false,
					dispose: true,
				})
			);
		}
		// Duplikat frame terakhir: semua kata sudah tampil, tahan sejenak sebelum loop
		frames.push(
			await webp.Image.generateFrame({
				buffer: buffers[buffers.length - 1],
				delay: holdMs,
				blend: false,
				dispose: true,
			})
		);

		return await webp.Image.save(null, {
			frames,
			width: BRAT_CANVAS,
			height: BRAT_CANVAS,
			loops: 0,
			bgColor: [255, 255, 255, 255],
			blend: false,
			dispose: true,
		});
	};

	let animBuffer = await renderAllFrames(92);
	if (animBuffer.length > BRATVID_MAX_SIZE_BYTES) {
		animBuffer = await renderAllFrames(65);
	}

	return animBuffer;
}

module.exports = {
	downloadMediaBuffer,
	imageToWebp,
	videoToWebp,
	webpToImage,
	addExif,
	createMemeSticker,
	createBratSticker,
	createBratVideoSticker,
};
