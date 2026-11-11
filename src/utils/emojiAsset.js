const axios = require("axios");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Apple Color Emoji PNG (160x160 dari iamcal/emoji-data, fallback 64x64 dari emoji-datasource-apple)
// agar tampilan emoji di stiker brat persis seperti emoji iPhone/iOS.
const EMOJI_SOURCES = [
	"https://cdn.jsdelivr.net/gh/iamcal/emoji-data@master/img-apple-160",
	"https://raw.githubusercontent.com/iamcal/emoji-data/master/img-apple-160",
	"https://cdn.jsdelivr.net/npm/emoji-datasource-apple@latest/img/apple/64",
	"https://unpkg.com/emoji-datasource-apple@latest/img/apple/64",
];
const CACHE_DIR = path.join(os.tmpdir(), "ambatubot-apple-emoji-cache");
const FETCH_TIMEOUT_MS = 8000;
const PNG_SIGNATURE = 0x89504e47;

// Hasil per kunci emoji: path file PNG, atau null bila tidak tersedia
const resolved = new Map();
let networkBlocked = false;

function toHexCodes(chars) {
	return chars.map((char) => char.codePointAt(0).toString(16).toLowerCase().padStart(4, "0"));
}

/**
 * Menyusun daftar kandidat nama file Apple emoji secara berurutan,
 * mengantisipasi variasi selector (-fe0f) maupun gabungan ZWJ/skin-tone.
 */
function candidateKeys(token) {
	const cleaned = [...token].filter((char) => char !== "\uFE0E");
	if (cleaned.length === 0) return [];

	const codes = toHexCodes(cleaned);
	const exact = codes.join("-");
	const withoutFe0f = codes.filter((code) => code !== "fe0f").join("-");
	const candidates = [exact];

	if (withoutFe0f && withoutFe0f !== exact) {
		candidates.push(withoutFe0f);
	}

	// Emoji BMP tunggal (mis. ❤ tanpa fe0f) sering disimpan dengan akhiran -fe0f
	if (codes.length === 1 && codes[0] !== "fe0f") {
		candidates.push(`${codes[0]}-fe0f`);
	}

	// Keycap tanpa fe0f (mis. 1️⃣) → sisipkan fe0f sebelum 20e3
	if (codes.length === 2 && codes[1] === "20e3") {
		candidates.push(`${codes[0]}-fe0f-20e3`);
	}

	// Gabungan ZWJ/skin-tone yang belum tersedia → fallback ke emoji dasarnya
	if (codes.length > 1) {
		const base = codes[0];
		if (!candidates.includes(base)) candidates.push(base);
		if (!candidates.includes(`${base}-fe0f`)) candidates.push(`${base}-fe0f`);
	}

	return candidates;
}

/** Unduh PNG emoji pertama yang berhasil dari daftar kandidat & mirror CDN. */
async function downloadCandidatePng(candidates) {
	let allSourcesUnreachable = true;

	for (const base of EMOJI_SOURCES) {
		let sourceFailed = false;

		for (const key of candidates) {
			try {
				const res = await axios.get(`${base}/${key}.png`, {
					responseType: "arraybuffer",
					timeout: FETCH_TIMEOUT_MS,
				});
				allSourcesUnreachable = false;
				const buffer = Buffer.from(res.data);
				if (buffer.length > 8 && buffer.readUInt32BE(0) === PNG_SIGNATURE) {
					return { key, buffer };
				}
			} catch (err) {
				if (err.response) {
					allSourcesUnreachable = false;
					// 404 berarti variasi kode ini tidak ada; lanjut coba kandidat lain di CDN ini
					if (err.response.status === 404) continue;
				}
				// Error jaringan / timeout / 5xx → pindah ke mirror CDN berikutnya
				sourceFailed = true;
				break;
			}
		}

		if (!sourceFailed) {
			// CDN merespons bersih dan seluruh kandidat 404 → tidak perlu cek mirror identik
			return null;
		}
	}

	if (allSourcesUnreachable) networkBlocked = true;
	return null;
}

/**
 * Mengambil PNG Apple/iPhone emoji berwarna dan menyimpannya di cache sementara.
 * @param {string} token - satu grafik emoji (boleh berupa gabungan ZWJ/keycap/skin-tone)
 * @returns {Promise<string|null>} path file PNG, atau null bila tidak tersedia
 */
async function getEmojiAssetPath(token) {
	const candidates = candidateKeys(token);
	if (candidates.length === 0) return null;

	const primaryKey = candidates[0];
	if (resolved.has(primaryKey)) return resolved.get(primaryKey);

	for (const key of candidates) {
		const cachedPath = path.join(CACHE_DIR, `${key}.png`);
		if (fs.existsSync(cachedPath)) {
			resolved.set(primaryKey, cachedPath);
			return cachedPath;
		}
	}

	if (networkBlocked) {
		resolved.set(primaryKey, null);
		return null;
	}

	const downloaded = await downloadCandidatePng(candidates);
	if (!downloaded) {
		resolved.set(primaryKey, null);
		return null;
	}

	const target = path.join(CACHE_DIR, `${downloaded.key}.png`);

	try {
		await fs.promises.mkdir(CACHE_DIR, { recursive: true });
		await fs.promises.writeFile(target, downloaded.buffer);
		resolved.set(primaryKey, target);
		return target;
	} catch (err) {
		// Cache gagal ditulis → simpan di tmp langsung
		const fallback = path.join(os.tmpdir(), `apple_emoji_${downloaded.key}_${Date.now()}.png`);
		try {
			await fs.promises.writeFile(fallback, downloaded.buffer);
			resolved.set(primaryKey, fallback);
			return fallback;
		} catch (writeErr) {
			resolved.set(primaryKey, null);
			return null;
		}
	}
}

module.exports = {
	getEmojiAssetPath,
};
