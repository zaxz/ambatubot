const axios = require("axios");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const sharp = require("sharp");
const { loadFont } = require("./ttfFont");
const { getEmojiAssetPath } = require("./emojiAsset");
const { ensureCjkFont } = require("./cjkFont");

const SCALE = 2; // 2x retina -> 880x1912 px
const CARD_W = 440;
const CARD_H = 956;
const OUT_W = CARD_W * SCALE;
const OUT_H = CARD_H * SCALE;

const SF_FONT_CACHE_DIR = path.join(os.tmpdir(), "ambatubot-sf-fonts");
const SF_FONT_SPECS = {
	textRegular: {
		file: "SF-Pro-Text-Regular.otf",
		url: "https://raw.githubusercontent.com/sahibjotsaggu/San-Francisco-Pro-Fonts/master/SF-Pro-Text-Regular.otf",
		fallback: path.resolve(__dirname, "../assets/arial.ttf"),
	},
	textSemibold: {
		file: "SF-Pro-Text-Semibold.otf",
		url: "https://raw.githubusercontent.com/sahibjotsaggu/San-Francisco-Pro-Fonts/master/SF-Pro-Text-Semibold.otf",
		fallback: path.resolve(__dirname, "../assets/arialbd.ttf"),
	},
};

const resolvedFonts = new Map();
let fontNetworkBlocked = false;

// 7 Emojis + 1 tombol plus di Reaction Pill (persis screenshot iOS WhatsApp)
const REACTION_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "🙏", "🤩"];
const EMOJI_PATTERN = /\p{Extended_Pictographic}|\p{Regional_Indicator}|[\u2600-\u27BF]|\u20E3/u;
const graphemeSegmenter =
	typeof Intl !== "undefined" && Intl.Segmenter ? new Intl.Segmenter("en", { granularity: "grapheme" }) : null;

const BG_MESSAGES = [
	{ text: "Gimana kabarnya?", sender: "received" },
	{ text: "Baik banget nih", sender: "sent" },
	{ text: "Syukurlah 😊", sender: "received" },
	{ text: "Udah makan?", sender: "received" },
	{ text: "Belom, sibuk", sender: "sent" },
	{ text: "Yaudah", sender: "received" },
	{ text: "Nanti aku telpon ya", sender: "sent" },
	{ text: "Oke siap", sender: "received" },
	{ text: "Eh iya, aku liat story kamu", sender: "received" },
	{ text: "Haha iya kemarin", sender: "sent" },
	{ text: "Keren sih tempatnya", sender: "received" },
	{ text: "Makasih 😁", sender: "sent" },
	{ text: "Besok jadi?", sender: "received" },
	{ text: "Jadi dong, jam 2 ya", sender: "sent" },
	{ text: "Siap, aku jemput", sender: "received" },
	{ text: "Oke ditunggu", sender: "sent" },
	{ text: "Oh iya, jangan lupa bawa", sender: "received" },
	{ text: "Siap boss", sender: "sent" },
	{ text: "Udah dulu ya, mandi dulu", sender: "sent" },
	{ text: "Yoi", sender: "received" },
	{ text: "Lagi dimana?", sender: "received" },
	{ text: "Dirumah aja", sender: "sent" },
	{ text: "Mau mampir?", sender: "received" },
	{ text: "Boleh, nanti sore", sender: "sent" },
	{ text: "Oke kabarin ya", sender: "received" },
	{ text: "Siap 🫡", sender: "sent" },
	{ text: "Oh iya tugas udah?", sender: "received" },
	{ text: "Udah kemarin", sender: "sent" },
	{ text: "Aku baru setengah", sender: "received" },
	{ text: "Cepet dong", sender: "sent" },
	{ text: "Iya iya", sender: "received" },
];

// Menu konteks untuk pesan gambar gaya WhatsApp iOS
const IMAGE_CONTEXT_MENU_ITEMS = [
	{
		label: "Balas",
		destructive: false,
		iconSvg:
			'<path d="M10 4.5L3.5 10.5L10 16.5V13C14.8 13 18.2 14.5 20.5 18.5C19.6 12.6 16.2 8.2 10 8V4.5Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" fill="none"/>',
	},
	{
		label: "Teruskan",
		destructive: false,
		iconSvg:
			'<path d="M14 4.5L20.5 10.5L14 16.5V13C9.2 13 5.8 14.5 3.5 18.5C4.4 12.6 7.8 8.2 14 8V4.5Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" fill="none"/>',
	},
	{
		label: "Salin",
		destructive: false,
		iconSvg:
			'<path d="M9 9.5C9 8.67 9.67 8 10.5 8H15L19 12V19C19 19.83 18.33 20.5 17.5 20.5H10.5C9.67 20.5 9 19.83 9 19Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" fill="none"/><path d="M15 8V12H19" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" fill="none"/><path d="M9 16H6.5C5.67 16 5 15.33 5 14.5V5C5 4.17 5.67 3.5 6.5 3.5H11L15 7.5V8" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" fill="none"/>',
	},
	{
		label: "Simpan",
		destructive: false,
		iconSvg:
			'<path d="M5 14.5V18.5C5 19.3 5.7 20 6.5 20H17.5C18.3 20 19 19.3 19 18.5V14.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/><path d="M12 4V15M7.5 10.5L12 15L16.5 10.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
	},
	{
		label: "Tanya Meta AI",
		destructive: false,
		iconSvg:
			'<path d="M12 3C7.03 3 3 7.03 3 12C3 16.97 7.03 21 12 21C16.97 21 21 16.97 21 12C21 7.03 16.97 3 12 3Z" stroke="currentColor" stroke-width="1.3" stroke-dasharray="2 3" stroke-linecap="round" fill="none"/><circle cx="12" cy="12" r="3.2" stroke="currentColor" stroke-width="1.4" fill="none"/>',
	},
	{
		label: "Hapus",
		destructive: true,
		iconSvg:
			'<path d="M4.5 6.5H19.5M9.5 6.5V4.5C9.5 3.95 9.95 3.5 10.5 3.5H13.5C14.05 3.5 14.5 3.95 14.5 4.5V6.5M6.5 6.5L7.3 18.8C7.4 19.75 8.15 20.5 9.1 20.5H14.9C15.85 20.5 16.6 19.75 16.7 18.8L17.5 6.5M9.6 10V17M12 10V17M14.4 10V17" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
	},
	{
		label: "Lainnya...",
		destructive: false,
		iconSvg:
			'<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.6" fill="none"/><circle cx="8" cy="12" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/><circle cx="16" cy="12" r="1.2" fill="currentColor"/>',
	},
];

// Menu konteks untuk pesan teks biasa gaya WhatsApp iOS
const TEXT_CONTEXT_MENU_ITEMS = [
	{
		label: "Balas",
		destructive: false,
		iconSvg:
			'<path d="M10 4.5L3.5 10.5L10 16.5V13C14.8 13 18.2 14.5 20.5 18.5C19.6 12.6 16.2 8.2 10 8V4.5Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" fill="none"/>',
	},
	{
		label: "Teruskan",
		destructive: false,
		iconSvg:
			'<path d="M14 4.5L20.5 10.5L14 16.5V13C9.2 13 5.8 14.5 3.5 18.5C4.4 12.6 7.8 8.2 14 8V4.5Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" fill="none"/>',
	},
	{
		label: "Salin",
		destructive: false,
		iconSvg:
			'<path d="M9 9.5C9 8.67 9.67 8 10.5 8H15L19 12V19C19 19.83 18.33 20.5 17.5 20.5H10.5C9.67 20.5 9 19.83 9 19Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" fill="none"/><path d="M15 8V12H19" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" fill="none"/><path d="M9 16H6.5C5.67 16 5 15.33 5 14.5V5C5 4.17 5.67 3.5 6.5 3.5H11L15 7.5V8" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" fill="none"/>',
	},
	{
		label: "Beri Bintang",
		destructive: false,
		iconSvg:
			'<path d="M12 3.2L14.65 8.55L20.55 9.4L16.25 13.55L17.25 19.45L12 16.65L6.75 19.45L7.75 13.55L3.45 9.4L9.35 8.55Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" fill="none"/>',
	},
	{
		label: "Sematkan",
		destructive: false,
		iconSvg:
			'<path d="M8.5 3.5H15.5C16.1 3.5 16.5 3.9 16.5 4.5C16.5 5.1 16.1 5.5 15.5 5.5H14.5V10L17.5 13C17.8 13.3 17.6 13.8 17.1 13.8H6.9C6.4 13.8 6.2 13.3 6.5 13L9.5 10V5.5H8.5C7.9 5.5 7.5 5.1 7.5 4.5C7.5 3.9 7.9 3.5 8.5 3.5Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" fill="none"/><line x1="12" y1="13.8" x2="12" y2="21" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
	},
	{
		label: "Hapus",
		destructive: true,
		iconSvg:
			'<path d="M4.5 6.5H19.5M9.5 6.5V4.5C9.5 3.95 9.95 3.5 10.5 3.5H13.5C14.05 3.5 14.5 3.95 14.5 4.5V6.5M6.5 6.5L7.3 18.8C7.4 19.75 8.15 20.5 9.1 20.5H14.9C15.85 20.5 16.6 19.75 16.7 18.8L17.5 6.5M9.6 10V17M12 10V17M14.4 10V17" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
	},
	{
		label: "Lainnya...",
		destructive: false,
		iconSvg:
			'<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.6" fill="none"/><circle cx="8" cy="12" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/><circle cx="16" cy="12" r="1.2" fill="currentColor"/>',
	},
];

function tokenize(text) {
	if (graphemeSegmenter) {
		return Array.from(graphemeSegmenter.segment(text), (part) => part.segment);
	}
	return [...text];
}

function escapeFfmpegPath(filePath) {
	return path.resolve(filePath).replace(/\\/g, "/").replace(/:/g, "\\:");
}

function runFfmpeg(args) {
	return new Promise((resolve, reject) => {
		const ff = spawn("ffmpeg", args);
		let stderr = "";
		ff.stderr.on("data", (d) => {
			stderr += d.toString();
		});
		ff.on("error", (err) => reject(new Error(`Gagal menjalankan FFmpeg: ${err.message}`)));
		ff.on("close", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`FFmpeg error (${code}): ${stderr.slice(-400)}`));
		});
	});
}

async function ensureSfFont(key) {
	if (resolvedFonts.has(key)) return resolvedFonts.get(key);
	const spec = SF_FONT_SPECS[key];
	const cached = path.join(SF_FONT_CACHE_DIR, spec.file);

	if (fs.existsSync(cached)) {
		resolvedFonts.set(key, cached);
		return cached;
	}

	if (!fontNetworkBlocked) {
		try {
			const res = await axios.get(spec.url, { responseType: "arraybuffer", timeout: 10000 });
			const buf = Buffer.from(res.data);
			if (buf.length > 10000) {
				await fs.promises.mkdir(SF_FONT_CACHE_DIR, { recursive: true });
				await fs.promises.writeFile(cached, buf);
				resolvedFonts.set(key, cached);
				return cached;
			}
		} catch (err) {
			if (!err.response) fontNetworkBlocked = true;
		}
	}

	resolvedFonts.set(key, spec.fallback);
	return spec.fallback;
}

/** Jam WIB format iPhone status bar (tanpa nol di depan jam, mis. 5:13 atau 14:48). */
function getCurrentIphoneTime() {
	const now = new Date();
	const wib = new Date(now.getTime() + now.getTimezoneOffset() * 60000 + 7 * 3600000);
	const hh = String(wib.getHours());
	const mm = String(wib.getMinutes()).padStart(2, "0");
	return `${hh}:${mm}`;
}

function wrapQuoteText(rawText, font, emojiMap, fontSize, maxContentW, fallbackFont = null) {
	const emojiWidthPx = fontSize * 1.15;
	const hasCharGlyph = (ch) => font.hasGlyph(ch) || Boolean(fallbackFont && fallbackFont.hasGlyph(ch));
	const charAdvancePx = (ch) => {
		if (font.hasGlyph(ch)) return font.advancePx(ch, fontSize);
		if (fallbackFont && fallbackFont.hasGlyph(ch)) return fallbackFont.advancePx(ch, fontSize);
		return 0;
	};
	const tokenWidthPx = (token) => {
		if (emojiMap.has(token)) return emojiWidthPx;
		let total = 0;
		for (const char of token) total += charAdvancePx(char);
		return total;
	};
	const measureLinePx = (tokens) => tokens.reduce((acc, t) => acc + tokenWidthPx(t), 0);

	const paragraphs = String(rawText || "").replace(/\uFE0E/g, "").split("\n");
	const wrappedLines = [];

	for (const para of paragraphs) {
		const cleanedTokens = tokenize(para).filter(
			(token) => /\s/.test(token) || emojiMap.has(token) || [...token].every(hasCharGlyph)
		);
		const paraStr = cleanedTokens.join("").replace(/[ \t]+/g, " ").trim();
		if (!paraStr) {
			if (wrappedLines.length > 0) wrappedLines.push({ tokens: [], widthPx: 0 });
			continue;
		}

		const words = paraStr.split(" ");
		let lineTokens = [];
		let lineWidth = 0;
		const spacePx = font.advancePx(" ", fontSize);

		for (const word of words) {
			const wordTokens = tokenize(word);
			const wordWidth = measureLinePx(wordTokens);

			if (lineTokens.length === 0) {
				if (wordWidth <= maxContentW) {
					lineTokens = wordTokens;
					lineWidth = wordWidth;
				} else {
					for (const tok of wordTokens) {
						const w = tokenWidthPx(tok);
						if (lineWidth + w > maxContentW && lineTokens.length > 0) {
							wrappedLines.push({ tokens: lineTokens, widthPx: lineWidth });
							lineTokens = [tok];
							lineWidth = w;
						} else {
							lineTokens.push(tok);
							lineWidth += w;
						}
					}
				}
			} else if (lineWidth + spacePx + wordWidth <= maxContentW) {
				lineTokens.push(" ", ...wordTokens);
				lineWidth += spacePx + wordWidth;
			} else {
				wrappedLines.push({ tokens: lineTokens, widthPx: lineWidth });
				if (wordWidth <= maxContentW) {
					lineTokens = wordTokens;
					lineWidth = wordWidth;
				} else {
					lineTokens = [];
					lineWidth = 0;
					for (const tok of wordTokens) {
						const w = tokenWidthPx(tok);
						if (lineWidth + w > maxContentW && lineTokens.length > 0) {
							wrappedLines.push({ tokens: lineTokens, widthPx: lineWidth });
							lineTokens = [tok];
							lineWidth = w;
						} else {
							lineTokens.push(tok);
							lineWidth += w;
						}
					}
				}
			}
		}

		if (lineTokens.length > 0) {
			wrappedLines.push({ tokens: lineTokens, widthPx: lineWidth });
		}
	}

	return wrappedLines;
}

/**
 * Layer latar belakang: header WhatsApp + chat gelembung + input bawah.
 * Seluruh layer ini akan diburamkan penuh agar header WA ikut blur seperti screenshot iPhone asli.
 */
function buildBlurredBackdropSvg({ hasAvatar }) {
	let y = 122;
	const bubbles = [];

	for (const msg of BG_MESSAGES) {
		const isSent = msg.sender === "sent";
		const bw = Math.min(285, Math.max(92, msg.text.length * 8.5 + 48));
		const bh = 54;
		const bx = isSent ? CARD_W - 14 - bw : 14;
		const fill = isSent ? "#0B6156" : "#252929";
		bubbles.push(`<rect x="${bx}" y="${y}" width="${bw}" height="${bh}" rx="18" fill="${fill}"/>`);
		bubbles.push(`<rect x="${bx + 14}" y="${y + 16}" width="${Math.max(40, bw - 40)}" height="11" rx="5" fill="rgba(255,255,255,0.22)"/>`);
		y += bh + 6;
		if (y > 895) break;
	}

	return `<svg xmlns="http://www.w3.org/2000/svg" width="${OUT_W}" height="${OUT_H}" viewBox="0 0 ${CARD_W} ${CARD_H}">
  <rect width="${CARD_W}" height="${CARD_H}" fill="#121617"/>
  <rect x="0" y="54" width="${CARD_W}" height="56" fill="#181C1D"/>
  <path d="M26 74L18 82L26 90" stroke="rgba(255,255,255,0.75)" stroke-width="2.5" stroke-linecap="round" fill="none"/>
  ${hasAvatar ? "" : '<circle cx="58" cy="82" r="18" fill="#3B6EA5"/>'}
  <rect x="86" y="72" width="118" height="12" rx="6" fill="rgba(255,255,255,0.55)"/>
  <rect x="86" y="89" width="54" height="8" rx="4" fill="rgba(255,255,255,0.25)"/>
  <rect x="366" y="75" width="22" height="14" rx="3" fill="rgba(255,255,255,0.55)"/>
  <circle cx="412" cy="82" r="8" fill="rgba(255,255,255,0.55)"/>
  ${bubbles.join("\n  ")}
  <rect x="0" y="906" width="${CARD_W}" height="50" fill="#181C1D"/>
  <rect x="48" y="914" width="336" height="32" rx="16" fill="rgba(255,255,255,0.12)"/>
</svg>`;
}

/** Path bubble WhatsApp iOS dengan ekor kecil di sudut bawah kiri atau kanan. */
function buildBubblePath(x, y, w, h, isRight) {
	const r = 16;
	if (isRight) {
		return [
			`M ${x + r} ${y}`,
			`L ${x + w - r} ${y}`,
			`Q ${x + w} ${y} ${x + w} ${y + r}`,
			`L ${x + w} ${y + h - 8}`,
			`Q ${x + w} ${y + h - 1} ${x + w + 5} ${y + h}`,
			`Q ${x + w - 4} ${y + h} ${x + w - 10} ${y + h - 2}`,
			`Q ${x + w - 13} ${y + h} ${x + w - r} ${y + h}`,
			`L ${x + r} ${y + h}`,
			`Q ${x} ${y + h} ${x} ${y + h - r}`,
			`L ${x} ${y + r}`,
			`Q ${x} ${y} ${x + r} ${y}`,
			"Z",
		].join(" ");
	}
	return [
		`M ${x + r} ${y}`,
		`L ${x + w - r} ${y}`,
		`Q ${x + w} ${y} ${x + w} ${y + r}`,
		`L ${x + w} ${y + h - r}`,
		`Q ${x + w} ${y + h} ${x + w - r} ${y + h}`,
		`L ${x + 12} ${y + h}`,
		`Q ${x + 7} ${y + h} ${x + 4} ${y + h - 2}`,
		`Q ${x - 1} ${y + h} ${x - 5} ${y + h}`,
		`Q ${x} ${y + h - 3} ${x} ${y + h - 9}`,
		`L ${x} ${y + r}`,
		`Q ${x} ${y} ${x + r} ${y}`,
		"Z",
	].join(" ");
}

/** Path untuk gambar di bagian atas bubble (hanya sudut atas kiri & kanan yang melengkung). */
function buildImageTopPath(x, y, w, h) {
	const r = 16;
	return [
		`M ${x + r} ${y}`,
		`L ${x + w - r} ${y}`,
		`Q ${x + w} ${y} ${x + w} ${y + r}`,
		`L ${x + w} ${y + h}`,
		`L ${x} ${y + h}`,
		`L ${x} ${y + r}`,
		`Q ${x} ${y} ${x + r} ${y}`,
		"Z",
	].join(" ");
}

/**
 * Menghasilkan gambar iPhone Quoted Chat (gaya WhatsApp iOS + header blur & status bar iOS)
 * sebagai Buffer PNG 880x1912.
 * @param {Object} options
 * @param {string} [options.text] - Isi pesan atau caption
 * @param {'you'|'other'} [options.side='other'] - Posisi bubble (kiri gelap atau kanan hijau)
 * @param {Buffer|null} [options.avatarBuffer] - Foto profil/grup untuk siluet blur di header atas
 * @param {Buffer|null} [options.imageBuffer] - Buffer gambar lampiran pesan
 * @param {string|null} [options.imageMime] - Mime gambar lampiran pesan
 * @param {string} [options.time] - Jam pada status bar & bubble (default jam WIB sekarang)
 * @param {number} [options.battery=100] - Persentase baterai di status bar
 * @returns {Promise<Buffer>}
 */
async function createIqcImage(options) {
	const {
		text = "",
		side = "other",
		avatarBuffer = null,
		imageBuffer = null,
		imageMime = null,
		time = getCurrentIphoneTime(),
		battery = 100,
	} = options;

	const cleanText = (text || "").trim();
	let hasImage = Boolean(imageBuffer && imageBuffer.length > 0);
	const hasText = Boolean(cleanText.length > 0);

	if (!hasImage && !hasText) {
		throw new Error("Pesan IQC tidak boleh kosong (butuh teks atau gambar).");
	}

	const [sfTextRegPath, sfTextSemiPath, ...reactionPaths] = await Promise.all([
		ensureSfFont("textRegular"),
		ensureSfFont("textSemibold"),
		...REACTION_EMOJIS.map((em) => getEmojiAssetPath(em).catch(() => null)),
	]);

	const textFont = loadFont(sfTextRegPath);

	// Ambil aset Apple emoji yang mungkin ada di dalam isi teks quote
	const rawTokens = tokenize(String(cleanText).replace(/\uFE0E/g, ""));
	const quoteEmojiTokens = [...new Set(
		rawTokens.filter((tok) => EMOJI_PATTERN.test(tok) && ![...tok].every((c) => textFont.hasGlyph(c)))
	)];
	const quoteEmojiMap = new Map();
	await Promise.all(
		quoteEmojiTokens.map(async (tok) => {
			const p = await getEmojiAssetPath(tok).catch(() => null);
			if (p) quoteEmojiMap.set(tok, p);
		})
	);

	const needsCjk = rawTokens.some(
		(tok) => !/\s/.test(tok) && !quoteEmojiMap.has(tok) && ![...tok].every((c) => textFont.hasGlyph(c))
	);
	const cjkFontPath = needsCjk ? await ensureCjkFont().catch(() => null) : null;
	const cjkFont = cjkFontPath ? loadFont(cjkFontPath) : null;

	const maxBubbleW = Math.round(CARD_W * 0.77); // ~338px
	const minBubbleW = Math.round(CARD_W * 0.55); // ~242px
	const bubblePadX = 14;
	const bubblePadY = 10;

	// Siapkan ukuran gambar (jika ada)
	let imageW = 0;
	let imageH = 0;
	if (hasImage) {
		try {
			const meta = await sharp(imageBuffer).metadata();
			const origW = meta.width || 400;
			const origH = meta.height || 300;
			const aspect = origH / origW;

			if (aspect >= 1.25) {
				// Format tegak / portrait
				imageW = Math.round(Math.min(maxBubbleW, Math.max(minBubbleW, 280 / aspect)));
				imageH = Math.min(310, Math.max(160, Math.round(imageW * aspect)));
			} else {
				// Format landscape / persegi
				imageW = maxBubbleW;
				imageH = Math.min(270, Math.max(140, Math.round(imageW * aspect)));
			}
		} catch (e) {
			hasImage = false;
		}
	}

	const maxContentW = (hasImage ? imageW : maxBubbleW) - bubblePadX * 2;
	let quoteFontSize = 15.5;
	let wrapped = [];
	if (hasText) {
		wrapped = wrapQuoteText(cleanText, textFont, quoteEmojiMap, quoteFontSize, maxContentW, cjkFont);
		if (wrapped.length > 7) {
			quoteFontSize = 14;
			wrapped = wrapQuoteText(cleanText, textFont, quoteEmojiMap, quoteFontSize, maxContentW, cjkFont);
		}
		if (wrapped.length > 10) {
			wrapped = wrapped.slice(0, 10);
			const lastLine = wrapped[wrapped.length - 1];
			lastLine.tokens = [...lastLine.tokens.slice(0, Math.max(1, lastLine.tokens.length - 2)), "..."];
			lastLine.widthPx = Math.min(maxContentW, lastLine.widthPx + 12);
		}
	}

	if (!hasImage && wrapped.length === 0) {
		throw new Error("Teks IQC tidak mengandung karakter yang dapat ditampilkan.");
	}

	const lineH = Math.round(quoteFontSize * 1.32);
	const bubbleTime = time.replace(":", ".");
	const timeFontSize = 11.5;
	const timeW = textFont.measurePx(bubbleTime, timeFontSize);
	const timeGap = 10;

	let bubbleW = 0;
	let bubbleH = 0;
	let captionH = 0;
	const captionPadTop = 6;
	const captionPadBottom = 8;

	if (hasImage && !hasText) {
		// Gambar saja tanpa caption
		bubbleW = imageW;
		bubbleH = imageH;
	} else if (hasImage && hasText) {
		// Gambar dengan caption
		bubbleW = imageW;
		const lastLine = wrapped[wrapped.length - 1];
		const inlineTimeFits = wrapped.length > 0 && lastLine.widthPx + timeGap + timeW <= maxContentW;
		const extraTimeRowH = inlineTimeFits ? 0 : 16;
		captionH = captionPadTop + wrapped.length * lineH + extraTimeRowH + captionPadBottom;

		const maxTotalBubbleH = 370;
		if (imageH + captionH > maxTotalBubbleH) {
			imageH = Math.max(130, maxTotalBubbleH - captionH);
		}
		bubbleH = imageH + captionH;
	} else {
		// Teks saja
		const lastLine = wrapped[wrapped.length - 1];
		const inlineTimeFits = wrapped.length > 0 && lastLine.widthPx + timeGap + timeW <= maxContentW;
		const lineWidths = wrapped.map((l) => l.widthPx);
		const widestLineW = Math.max(...lineWidths, timeW);
		bubbleW = Math.min(maxBubbleW, Math.max(92, Math.ceil(widestLineW + bubblePadX * 2)));
		const extraTimeRowH = inlineTimeFits ? 0 : 16;
		bubbleH = Math.ceil(bubblePadY * 2 + wrapped.length * lineH + extraTimeRowH - 2);
	}

	// Reaction Pill layout (7 emoji + 1 tombol plus)
	const reactionH = 52;
	const emojiSize = 30;
	const reactionPadX = 14;
	const emojiGap = 12;
	const plusBtnSize = 30;
	const reactionW = reactionPadX * 2 + REACTION_EMOJIS.length * (emojiSize + emojiGap) + plusBtnSize;

	// Context Menu layout (7 baris, teks di sebelah kanan ikon seperti iOS asli)
	const contextMenuItems = hasImage ? IMAGE_CONTEXT_MENU_ITEMS : TEXT_CONTEXT_MENU_ITEMS;
	const menuRowH = 46;
	const menuH = contextMenuItems.length * menuRowH;
	const menuW = 270;
	const stackGap = 8;

	const totalStackH = reactionH + stackGap + bubbleH + stackGap + menuH;
	const areaTop = 76;
	const areaBottom = 928;
	const stackTop = Math.max(areaTop, Math.round(areaTop + (areaBottom - areaTop - totalStackH) / 2));

	const isRight = side === "you";
	const marginSide = 16;

	const reactionX = isRight ? CARD_W - marginSide - reactionW : marginSide;
	const reactionY = stackTop;

	const bubbleX = isRight ? CARD_W - marginSide - bubbleW : marginSide;
	const bubbleY = reactionY + reactionH + stackGap;

	const menuX = isRight ? CARD_W - marginSide - menuW : marginSide;
	const menuY = bubbleY + bubbleH + stackGap;

	const plusCenterX = reactionX + reactionPadX + REACTION_EMOJIS.length * (emojiSize + emojiGap) + plusBtnSize / 2;
	const plusCenterY = reactionY + reactionH / 2;

	let imgPillX = 0;
	let imgPillY = 0;
	let imgPillW = 0;
	let imgPillH = 0;
	if (hasImage && !hasText) {
		imgPillW = Math.ceil(timeW) + 12;
		imgPillH = 18;
		imgPillX = bubbleX + bubbleW - imgPillW - 12;
		imgPillY = bubbleY + bubbleH - imgPillH - 8;
	}

	// 2. Render latar belakang blur
	const bgComposites = [];
	if (avatarBuffer) {
		try {
			const circleMask = Buffer.from(
				`<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72"><circle cx="36" cy="36" r="36" fill="white"/></svg>`
			);
			const roundAvatar = await sharp(avatarBuffer)
				.resize(72, 72, { fit: "cover" })
				.composite([{ input: circleMask, blend: "dest-in" }])
				.png()
				.toBuffer();
			bgComposites.push({ input: roundAvatar, left: 40 * SCALE, top: 64 * SCALE });
		} catch (e) {
			// Abaikan foto avatar korup
		}
	}

	const rawBackdropSvg = Buffer.from(buildBlurredBackdropSvg({ hasAvatar: bgComposites.length > 0 }));
	const unblurredBg = bgComposites.length > 0
		? await sharp(rawBackdropSvg).composite(bgComposites).png().toBuffer()
		: await sharp(rawBackdropSvg).png().toBuffer();

	const blurredBgBuf = await sharp(unblurredBg)
		.blur(26)
		.modulate({ saturation: 1.4, brightness: 0.65 })
		.png()
		.toBuffer();

	// 3. Bangun layer foreground dasar (Status Bar, Reaction Pill dasar, Bubble Fill, Menu Container)
	const pct = Math.min(100, Math.max(5, Math.round(battery)));
	const isLowBat = pct <= 20;
	const batBodyW = 25;
	const batBodyH = 12.6;
	const batInnerPad = 1.9;
	const batMaxFillW = batBodyW - batInnerPad * 2;
	const batFillW = Math.max(3, (pct / 100) * batMaxFillW);
	const batX = 378;
	const batY = 20.5;

	const bubblePath = buildBubblePath(bubbleX, bubbleY, bubbleW, bubbleH, isRight);
	const bubbleFill = isRight ? "#075E54" : "#272729";

	const fgSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${OUT_W}" height="${OUT_H}" viewBox="0 0 ${CARD_W} ${CARD_H}">
  <!-- StatusBar iPhone: signal + WiFi + battery -->
  <g transform="translate(328, 21)" color="#FFFFFF">
    <rect x="0" y="7.5" width="3.1" height="4.5" rx="1.45" fill="currentColor"/>
    <rect x="4.7" y="5.2" width="3.1" height="6.8" rx="1.45" fill="currentColor"/>
    <rect x="9.4" y="2.6" width="3.1" height="9.4" rx="1.45" fill="currentColor"/>
    <rect x="14.1" y="0" width="3.1" height="12" rx="1.45" fill="currentColor"/>
  </g>
  <g transform="translate(352, 20.8)" color="#FFFFFF">
    <path d="M8.5 11.8 L6.31 9.61 A3.1 3.1 0 0 1 10.69 9.61 Z" fill="currentColor"/>
    <path d="M3.55 6.85 A7.0 7.0 0 0 1 13.45 6.85 L11.96 8.34 A4.9 4.9 0 0 0 5.04 8.34 Z" fill="currentColor"/>
    <path d="M0.79 4.09 A10.9 10.9 0 0 1 16.21 4.09 L14.72 5.58 A8.8 8.8 0 0 0 2.28 5.58 Z" fill="currentColor"/>
  </g>
  <g>
    <rect x="${batX}" y="${batY}" width="${batBodyW}" height="${batBodyH}" rx="3.8" stroke="rgba(255,255,255,0.45)" stroke-width="1.25" fill="none"/>
    <rect x="${batX + batInnerPad}" y="${batY + batInnerPad}" width="${batFillW}" height="${batBodyH - batInnerPad * 2}" rx="1.8" fill="${isLowBat ? "#FFD60A" : "#FFFFFF"}"/>
    <path d="M${batX + batBodyW + 1.5} ${batY + 4.1} A2.1 2.1 0 0 1 ${batX + batBodyW + 1.5} ${batY + 8.5} Z" fill="rgba(255,255,255,0.45)"/>
  </g>
  <!-- EmojiReactions Pill Background -->
  <rect x="${reactionX}" y="${reactionY}" width="${reactionW}" height="${reactionH}" rx="${reactionH / 2}" fill="rgba(44,44,46,0.92)"/>
  <!-- Highlighted ChatBubble -->
  <path d="${bubblePath}" fill="${bubbleFill}"/>
  <!-- ContextMenu Container -->
  <rect x="${menuX}" y="${menuY}" width="${menuW}" height="${menuH}" rx="18" fill="rgba(37,37,39,0.92)"/>
</svg>`;

	const composites = [{ input: Buffer.from(fgSvg), top: 0, left: 0 }];

	// 4. Proses masking gambar (jika ada lampiran gambar)
	if (hasImage && !hasText) {
		// Gambar saja tanpa caption: bentuk seluruh bubble mengikuti bubblePath (dengan ekor & sudut melengkung)
		const pad = 8;
		const maskW = bubbleW + pad * 2;
		const maskH = bubbleH + pad * 2;
		const maskPath = buildBubblePath(pad, pad, bubbleW, bubbleH, isRight);
		const maskSvg = Buffer.from(
			`<svg xmlns="http://www.w3.org/2000/svg" width="${maskW * SCALE}" height="${maskH * SCALE}" viewBox="0 0 ${maskW} ${maskH}">
				<path d="${maskPath}" fill="#ffffff"/>
			</svg>`
		);

		const maskedImg = await sharp(imageBuffer)
			.resize(bubbleW * SCALE, bubbleH * SCALE, { fit: "cover", position: "center" })
			.extend({
				top: pad * SCALE,
				bottom: pad * SCALE,
				left: pad * SCALE,
				right: pad * SCALE,
				background: { r: 0, g: 0, b: 0, alpha: 0 },
			})
			.composite([{ input: maskSvg, blend: "dest-in" }])
			.png()
			.toBuffer();

		composites.push({
			input: maskedImg,
			left: Math.round((bubbleX - pad) * SCALE),
			top: Math.round((bubbleY - pad) * SCALE),
		});
	} else if (hasImage && hasText) {
		// Gambar dengan caption: bagian atas gambar melengkung, bagian bawah datar bertemu caption
		const topMaskPath = buildImageTopPath(0, 0, bubbleW, imageH);
		const maskSvg = Buffer.from(
			`<svg xmlns="http://www.w3.org/2000/svg" width="${bubbleW * SCALE}" height="${imageH * SCALE}" viewBox="0 0 ${bubbleW} ${imageH}">
				<path d="${topMaskPath}" fill="#ffffff"/>
			</svg>`
		);

		const maskedImg = await sharp(imageBuffer)
			.resize(bubbleW * SCALE, imageH * SCALE, { fit: "cover", position: "center" })
			.composite([{ input: maskSvg, blend: "dest-in" }])
			.png()
			.toBuffer();

		composites.push({
			input: maskedImg,
			left: Math.round(bubbleX * SCALE),
			top: Math.round(bubbleY * SCALE),
		});
	}

	// 5. Overlay SVG di atas gambar (Pill jam di gambar, ikon menu konteks di kiri baris, tombol plus)
	const menuRowsSvg = contextMenuItems.map((item, idx) => {
		const rowY = menuY + idx * menuRowH;
		const iconColor = item.destructive ? "#FF453A" : "#FFFFFF";
		const divider =
			idx < contextMenuItems.length - 1
				? `<line x1="${menuX + 50}" y1="${rowY + menuRowH}" x2="${menuX + menuW}" y2="${rowY + menuRowH}" stroke="rgba(255,255,255,0.08)" stroke-width="0.6"/>`
				: "";
		return `
      <g transform="translate(${menuX + 18}, ${rowY + 13})" color="${iconColor}">
        <svg width="20" height="20" viewBox="0 0 24 24">${item.iconSvg}</svg>
      </g>
      ${divider}`;
	}).join("\n");

	const overlaySvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${OUT_W}" height="${OUT_H}" viewBox="0 0 ${CARD_W} ${CARD_H}">
  <!-- Tombol plus pada Reaction Pill -->
  <circle cx="${plusCenterX}" cy="${plusCenterY}" r="${plusBtnSize / 2}" fill="rgba(255,255,255,0.18)"/>
  <g transform="translate(${plusCenterX - 10}, ${plusCenterY - 10})">
    <svg width="20" height="20" viewBox="0 0 24 24">
      <path d="M12 4.5V19.5M4.5 12H19.5" stroke="#C7C7CC" stroke-width="2.3" stroke-linecap="round" fill="none"/>
    </svg>
  </g>
  ${hasImage && !hasText ? `<!-- Pill gelap untuk jam pada gambar tanpa caption -->
  <rect x="${imgPillX}" y="${imgPillY}" width="${imgPillW}" height="${imgPillH}" rx="9" fill="rgba(0,0,0,0.50)"/>` : ""}
  <!-- Ikon & Divider Menu Konteks (Ikon di sebelah kiri) -->
  ${menuRowsSvg}
</svg>`;

	composites.push({ input: Buffer.from(overlaySvg), top: 0, left: 0 });

	// Reaction emojis
	for (let i = 0; i < REACTION_EMOJIS.length; i++) {
		const emojiPath = reactionPaths[i];
		if (!emojiPath) continue;
		const resized = await sharp(emojiPath).resize(emojiSize * SCALE, emojiSize * SCALE, { fit: "contain" }).png().toBuffer();
		composites.push({
			input: resized,
			left: Math.round((reactionX + reactionPadX + i * (emojiSize + emojiGap)) * SCALE),
			top: Math.round((reactionY + (reactionH - emojiSize) / 2) * SCALE),
		});
	}

	const tmpDir = os.tmpdir();
	const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
	const textDir = path.join(tmpDir, `iqc_txt_${runId}`);
	const baseImgPath = path.join(tmpDir, `iqc_base_${runId}.png`);
	const outImgPath = path.join(tmpDir, `iqc_out_${runId}.png`);

	try {
		await fs.promises.mkdir(textDir, { recursive: true });
		const textFiles = new Map();
		const writeText = async (str) => {
			if (textFiles.has(str)) return textFiles.get(str);
			const file = path.join(textDir, `t${textFiles.size}.txt`);
			await fs.promises.writeFile(file, str, "utf8");
			textFiles.set(str, file);
			return file;
		};

		const draws = [];
		const addDrawText = async ({ text: str, fontPath, size, color, xExpr, baselineY }) => {
			if (!str) return;
			const file = await writeText(str);
			const yExpr = `${Math.round(baselineY * SCALE)}-max_glyph_a`;
			draws.push(
				`drawtext=fontfile='${escapeFfmpegPath(fontPath)}':textfile='${escapeFfmpegPath(file)}':expansion=none:fontcolor=${color}:fontsize=${Math.round(size * SCALE)}:x=${xExpr}:y=${yExpr}`
			);
		};

		// Jam iPhone di kiri status bar
		await addDrawText({
			text: time,
			fontPath: sfTextSemiPath,
			size: 16.5,
			color: "#FFFFFF",
			xExpr: String(34 * SCALE),
			baselineY: 32.5,
		});

		// Isi teks caption / bubble (jika ada teks)
		if (hasText) {
			const emojiDrawSize = Math.round(quoteFontSize * 1.12);
			const captionStartY = bubbleY + (hasImage ? imageH + captionPadTop : bubblePadY);

			for (let i = 0; i < wrapped.length; i++) {
				const line = wrapped[i];
				const lineBaseline = captionStartY + quoteFontSize * 0.92 + i * lineH;
				let penX = bubbleX + bubblePadX;
				let run = "";
				let runFont = textFont;
				let runFontPath = sfTextRegPath;

				const flushText = async () => {
					if (!run) return;
					await addDrawText({
						text: run,
						fontPath: runFontPath,
						size: quoteFontSize,
						color: "#FFFFFF",
						xExpr: String(Math.round(penX * SCALE)),
						baselineY: lineBaseline,
					});
					for (const ch of run) {
						if (runFont.hasGlyph(ch)) penX += runFont.advancePx(ch, quoteFontSize);
					}
					run = "";
				};

				for (const tok of line.tokens) {
					if (quoteEmojiMap.has(tok)) {
						await flushText();
						const resized = await sharp(quoteEmojiMap.get(tok))
							.resize(emojiDrawSize * SCALE, emojiDrawSize * SCALE, { fit: "contain" })
							.png()
							.toBuffer();
						composites.push({
							input: resized,
							left: Math.round(penX * SCALE),
							top: Math.round((lineBaseline - quoteFontSize * 0.85) * SCALE),
						});
						penX += quoteFontSize * 1.15;
					} else {
						for (const ch of tok) {
							let nextFont = textFont;
							let nextPath = sfTextRegPath;
							if (/\s/.test(ch) && run && runFont.hasGlyph(ch)) {
								nextFont = runFont;
								nextPath = runFontPath;
							} else if (!textFont.hasGlyph(ch) && cjkFont && cjkFont.hasGlyph(ch)) {
								nextFont = cjkFont;
								nextPath = cjkFontPath;
							}
							if (run && nextPath !== runFontPath) {
								await flushText();
							}
							runFont = nextFont;
							runFontPath = nextPath;
							run += ch;
						}
					}
				}
				await flushText();
			}

			// Timestamp di pojok kanan bawah bubble
			await addDrawText({
				text: bubbleTime,
				fontPath: sfTextRegPath,
				size: timeFontSize,
				color: "0xffffff@0.48",
				xExpr: String(Math.round((bubbleX + bubbleW - bubblePadX - timeW) * SCALE)),
				baselineY: bubbleY + bubbleH - 7,
			});
		} else if (hasImage) {
			// Jam di dalam gambar tanpa caption (di dalam pill hitam)
			await addDrawText({
				text: bubbleTime,
				fontPath: sfTextRegPath,
				size: timeFontSize,
				color: "#FFFFFF",
				xExpr: String(Math.round((imgPillX + 6) * SCALE)),
				baselineY: imgPillY + 13.5,
			});
		}

		// 7 label teks menu konteks di sebelah kanan ikon
		for (let idx = 0; idx < contextMenuItems.length; idx++) {
			const item = contextMenuItems[idx];
			await addDrawText({
				text: item.label,
				fontPath: sfTextRegPath,
				size: 16,
				color: item.destructive ? "#FF453A" : "#FFFFFF",
				xExpr: String(Math.round((menuX + 52) * SCALE)),
				baselineY: menuY + idx * menuRowH + 28.5,
			});
		}

		const baseBuffer = await sharp(blurredBgBuf).composite(composites).png().toBuffer();
		await fs.promises.writeFile(baseImgPath, baseBuffer);

		await runFfmpeg(["-y", "-i", baseImgPath, "-vf", draws.join(","), outImgPath]);

		return await fs.promises.readFile(outImgPath);
	} finally {
		if (fs.existsSync(baseImgPath)) await fs.promises.unlink(baseImgPath).catch(() => {});
		if (fs.existsSync(outImgPath)) await fs.promises.unlink(outImgPath).catch(() => {});
		await fs.promises.rm(textDir, { recursive: true, force: true }).catch(() => {});
	}
}

module.exports = {
	createIqcImage,
};
