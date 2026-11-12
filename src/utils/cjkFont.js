const axios = require("axios");
const fs = require("fs");
const os = require("os");
const path = require("path");

const CJK_FONT_CACHE_DIR = path.join(os.tmpdir(), "ambatubot-sf-fonts");
const CJK_FONT_FILE = "DroidSansFallbackFull.ttf";
const CJK_FONT_URL =
	"https://raw.githubusercontent.com/aosp-mirror/platform_frameworks_base/master/data/fonts/DroidSansFallbackFull.ttf";

const CJK_CHAR_PATTERN =
	/[\u3040-\u30FF\u31F0-\u31FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/;
const KANA_PATTERN = /[\u3040-\u30FF\u31F0-\u31FF]/;
const TRAILING_PUNCT_PATTERN = /^[。、！？．，：；」』）】〉》!?.,:;)\]]+$/;

let resolvedCjkPath = null;
let cjkNetworkBlocked = false;
let pendingCjkPromise = null;

/**
 * Mengunduh dan men-cache font fallback CJK (Jepang & Mandarin) secara lazy di temp dir.
 * @returns {Promise<string|null>}
 */
async function ensureCjkFont() {
	if (resolvedCjkPath && fs.existsSync(resolvedCjkPath)) return resolvedCjkPath;

	const cached = path.join(CJK_FONT_CACHE_DIR, CJK_FONT_FILE);
	if (fs.existsSync(cached)) {
		resolvedCjkPath = cached;
		return cached;
	}

	if (cjkNetworkBlocked) return null;
	if (pendingCjkPromise) return pendingCjkPromise;

	pendingCjkPromise = (async () => {
		try {
			const res = await axios.get(CJK_FONT_URL, {
				responseType: "arraybuffer",
				timeout: 30000,
			});
			const buf = Buffer.from(res.data);
			if (buf.length > 100000) {
				await fs.promises.mkdir(CJK_FONT_CACHE_DIR, { recursive: true });
				await fs.promises.writeFile(cached, buf);
				resolvedCjkPath = cached;
				return cached;
			}
		} catch (err) {
			if (!err.response) cjkNetworkBlocked = true;
		} finally {
			pendingCjkPromise = null;
		}
		return null;
	})();

	return pendingCjkPromise;
}

/**
 * Memecah kata pada teks CJK (yang umumnya tanpa spasi) untuk wrapping & animasi.
 * Tanda baca penutup ditempelkan ke kata sebelumnya agar tidak menggantung sendirian.
 * @param {string} text
 * @returns {Array<string>}
 */
function segmentCjkWords(text) {
	if (!text) return [];
	if (!CJK_CHAR_PATTERN.test(text)) return [text];

	if (typeof Intl === "undefined" || !Intl.Segmenter) {
		return [...text];
	}

	const locale = KANA_PATTERN.test(text) ? "ja" : "zh";
	const segmenter = new Intl.Segmenter(locale, { granularity: "word" });
	const raw = Array.from(segmenter.segment(text), (part) => part.segment).filter(Boolean);

	const merged = [];
	for (const seg of raw) {
		if (merged.length > 0 && TRAILING_PUNCT_PATTERN.test(seg)) {
			merged[merged.length - 1] += seg;
		} else {
			merged.push(seg);
		}
	}
	return merged;
}

module.exports = {
	ensureCjkFont,
	segmentCjkWords,
	CJK_CHAR_PATTERN,
};
