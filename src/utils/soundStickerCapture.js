const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/**
 * Penangkap sampel sound sticker ASLI untuk reverse engineering.
 *
 * KENAPA FILE INI ADA (baca sebelum mengubah):
 * Sound sticker resmi WhatsApp (beta Android 2.26.47.1) membawa trek audio
 * di dalam pesan stiker, tapi format proto-nya belum ada di Baileys v7.
 * Lebih parah lagi: decoder protobuf Baileys MEMBUANG field yang tidak
 * dikenal (`r.skipType(...)` di WAProto/index.js). Jadi kalau kita cuma
 * me-log `msg.message.stickerMessage` di handler biasa, field audio yang
 * baru itu sudah hilang sebelum sampai ke handler — log akan terlihat
 * seperti stiker biasa.
 *
 * Karena itu file ini menambal `proto.Message.decode` SEBELUM socket
 * Baileys dibuat, lalu memindai byte protobuf mentah setiap pesan masuk
 * dengan parser generik (tanpa skema).
 *
 * TEMUAN 2026-11-25 (v2): stiker BIASA ketangkap, tapi sound sticker TIDAK
 * ketangkap sama sekali — tidak ada file apa pun. Artinya sound sticker
 * TIDAK datang sebagai `stickerMessage` (field 26 di Message) untuk klien
 * WhatsApp Web seperti bot ini; ia pasti datang sebagai field Message lain
 * (mis. `lottieStickerMessage` = 74 atau field baru), terbungkus pesan lain,
 * atau memang tidak dikirim server ke klien Web. Karena itu sejak v2
 * penangkap ini mencatat NOMOR FIELD TOP-LEVEL setiap pesan masuk ke
 * `message-types.log`, dan menyimpan scan penuh untuk pesan apa pun yang
 * BUKAN teks biasa dan BUKAN stiker biasa — apa pun bentuk sound sticker
 * itu, ia akan ketangkap. Kalau setelah ini pun tidak ada jejak saat sound
 * sticker dikirim, kesimpulannya: server WhatsApp belum mengirim sound
 * sticker ke klien Web, dan penangkapan harus lewat jalur lain.
 *
 * Hasil disimpan ke `data/sound-sticker-samples/` (folder itu di-.gitignore,
 * tidak ikut ter-commit; ambil filenya lewat File Manager panel lalu kirim
 * ke Muse).
 *
 * Keamanan: penangkap ini TIDAK PERNAH boleh merusak penerimaan pesan.
 * Semua pemindaian dibungkus try/catch; kalau pemindaian gagal, decode
 * asli tetap dipakai dan pesannya tetap diproses seperti biasa.
 */

const SAMPLE_DIR = path.join(__dirname, "..", "..", "data", "sound-sticker-samples");

// Field StickerMessage yang dikenal Baileys 7.0.0-rc14 (WAProto.proto:3481-3503).
// Field di luar daftar ini = kandidat field audio baru dari WhatsApp.
const KNOWN_STICKER_FIELDS = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 16, 17, 18, 19, 20, 21, 22, 23]);

// ---------------------------------------------------------------------------
// Parser protobuf generik (tanpa dependensi, tanpa skema)
// ---------------------------------------------------------------------------

function readVarint(buf, pos) {
	let result = 0n;
	let shift = 0n;
	let p = pos;
	while (p < buf.length) {
		const b = buf[p++];
		result |= BigInt(b & 0x7f) << shift;
		if (!(b & 0x80)) return { value: result, next: p };
		shift += 7n;
		if (shift > 70n) throw new Error("varint terlalu panjang");
	}
	throw new Error("varint terpotong");
}

// Coba parse bytes sebagai sub-message; kembalikan null kalau bukan message
// (misalnya hash acak 32 byte). Syarat: parse harus menghabiskan seluruh
// buffer dan semua nomor field masuk akal (< 100).
function tryParseSubmessage(bytes, inSticker) {
	try {
		const fields = parseFields(bytes, false, inSticker);
		if (!fields.length) return null;
		if (fields.some((f) => f.field <= 0 || f.field > 100)) return null;
		return fields;
	} catch {
		return null;
	}
}

// isTopLevel: sedang mem-parse Message itu sendiri.
// inSticker: sedang mem-parse isi stickerMessage (field 26) — di dalamnya
// hanya field yang belum dikenal yang diurai lebih dalam dan disimpan mentah.
function parseFields(buf, isTopLevel, inSticker) {
	const fields = [];
	let pos = 0;
	while (pos < buf.length) {
		const tag = readVarint(buf, pos);
		pos = tag.next;
		const fieldNo = Number(tag.value >> 3n);
		const wireType = Number(tag.value & 7n);
		if (fieldNo === 0) break;

		if (wireType === 0) {
			// varint
			const v = readVarint(buf, pos);
			pos = v.next;
			fields.push({ field: fieldNo, wireType, value: v.value.toString() });
		} else if (wireType === 1) {
			// 64-bit
			fields.push({ field: fieldNo, wireType, value: buf.subarray(pos, pos + 8).toString("hex") });
			pos += 8;
		} else if (wireType === 5) {
			// 32-bit
			fields.push({ field: fieldNo, wireType, value: buf.subarray(pos, pos + 4).toString("hex") });
			pos += 4;
		} else if (wireType === 2) {
			// length-delimited (string / bytes / sub-message)
			const len = readVarint(buf, pos);
			pos = len.next;
			const length = Number(len.value);
			if (pos + length > buf.length) throw new Error("length-delimited terpotong");
			const bytes = buf.subarray(pos, pos + length);
			pos += length;
			const entry = { field: fieldNo, wireType, length };
			entry.previewHex = bytes.subarray(0, 64).toString("hex");
			const asText = bytes.toString("utf8");
			if (/^[\x20-\x7e]{4,}$/.test(asText)) entry.previewText = asText.slice(0, 120);
			// Di top-level, urai semua sub-message (stiker, gambar, dan apa
			// pun yang baru) agar struktur sound sticker terlihat apa pun
			// field-nya. Di dalam stiker, hanya field tak dikenal yang
			// diurai dan disimpan mentah.
			const shouldRecurse =
				isTopLevel ||
				(inSticker && !KNOWN_STICKER_FIELDS.has(fieldNo)) ||
				(!isTopLevel && !inSticker);
			if (shouldRecurse) {
				const children = tryParseSubmessage(bytes, isTopLevel ? fieldNo === 26 : inSticker);
				if (children) entry.children = children;
				// Simpan bytes mentah field tak dikenal di dalam stiker secara
				// utuh (isinya metadata kecil: mediaKey/directPath/durasi —
				// bukan file audio).
				if (inSticker && !KNOWN_STICKER_FIELDS.has(fieldNo)) {
					entry.rawBase64 = bytes.toString("base64");
				}
			}
			fields.push(entry);
		} else {
			fields.push({ field: fieldNo, wireType, value: "(wire type tidak dikenal, berhenti)" });
			break;
		}
	}
	return fields;
}

// Pindai byte Message mentah: kembalikan daftar field top-level, seluruh
// field top-level yang terurai, field stickerMessage, dan field stiker yang
// belum dikenal Baileys.
function scanMessageBytes(buffer) {
	const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
	const top = parseFields(buf, true, false);
	const sticker = top.find((f) => f.field === 26);
	const stickerFields = sticker?.children || null;
	const unknownStickerFields = stickerFields
		? stickerFields.filter((f) => !KNOWN_STICKER_FIELDS.has(f.field))
		: [];
	return { topLevelFields: top.map((f) => f.field), topFields: top, stickerFields, unknownStickerFields };
}

function sanitizeForJson(value) {
	if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
		return { $bytesBase64: Buffer.from(value).toString("base64") };
	}
	if (value && typeof value === "object" && typeof value.toString === "function" && value.constructor?.name === "Long") {
		return value.toString();
	}
	return value;
}

// Satu baris JSON per pesan masuk: jam + nomor field top-level-nya saja.
// File ini yang membuktikan sound sticker datang sebagai tipe apa (atau
// tidak datang sama sekali) meskipun scan penuhnya tidak tersimpan.
function appendTypeLog(scan) {
	try {
		fs.mkdirSync(SAMPLE_DIR, { recursive: true });
		fs.appendFileSync(
			path.join(SAMPLE_DIR, "message-types.log"),
			JSON.stringify({ ts: new Date().toISOString(), fields: scan.topLevelFields }) + "\n",
			"utf8"
		);
	} catch {
		// Log tipe pesan tidak boleh mengganggu apa pun.
	}
}

function saveSample(scan, decodedSticker, contentHash) {
	try {
		fs.mkdirSync(SAMPLE_DIR, { recursive: true });
		const existing = fs.readdirSync(SAMPLE_DIR).find((f) => f.endsWith(`-${contentHash}.json`));
		if (existing) return path.join(SAMPLE_DIR, existing); // pesan yang sama sudah tersimpan
		const ts = new Date().toISOString().replace(/[:.]/g, "-");
		const file = path.join(SAMPLE_DIR, `${ts}-${contentHash}.json`);
		const payload = {
			capturedAt: new Date().toISOString(),
			note: "Sampel pesan mentah (metadata proto saja, bukan file gambar/audio). Field stiker yang tidak dikenal Baileys = kandidat field audio sound sticker. Kalau pesan ini bukan stiker biasa, lihat topFields: itulah bentuk asli pesan yang dikirim.",
			unknownStickerFields: scan.unknownStickerFields,
			topLevelFields: scan.topLevelFields,
			topFields: scan.topFields,
			stickerFields: scan.stickerFields,
			decodedStickerKnownFields: decodedSticker
				? JSON.parse(JSON.stringify(decodedSticker, (k, v) => sanitizeForJson(v)))
				: null,
		};
		fs.writeFileSync(file, JSON.stringify(payload, null, 2), "utf8");
		if (scan.stickerFields) {
			console.log(
				`🔊 [SOUND-STICKER-CAPTURE] Stiker masuk tersimpan: ${file} | field tak dikenal: ` +
					(scan.unknownStickerFields.length
						? scan.unknownStickerFields.map((f) => f.field).join(", ")
						: "tidak ada (stiker biasa)")
			);
		} else {
			console.log(
				`🔊 [SOUND-STICKER-CAPTURE] Pesan non-teks masuk tersimpan: ${file} | field top-level: ${scan.topLevelFields.join(", ")}`
			);
		}
		return file;
	} catch (err) {
		console.warn("[SOUND-STICKER-CAPTURE] Gagal menyimpan sampel:", err.message);
		return null;
	}
}

let installed = false;

// Pasang penangkap di proto.Message.decode. HARUS dipanggil sebelum
// makeWASocket() — index.js memanggilnya di awal, sebelum startBot().
function installSoundStickerCapture() {
	if (installed) return true;
	installed = true;
	let proto;
	try {
		({ proto } = require("@whiskeysockets/baileys"));
	} catch (err) {
		console.warn("[SOUND-STICKER-CAPTURE] Baileys tidak ditemukan, penangkap nonaktif:", err.message);
		return false;
	}
	if (!proto?.Message?.decode || typeof proto.Message.decode !== "function") {
		console.warn("[SOUND-STICKER-CAPTURE] proto.Message.decode tidak ditemukan, penangkap nonaktif.");
		return false;
	}
	const originalDecode = proto.Message.decode.bind(proto.Message);
	proto.Message.decode = function (input, ...rest) {
		const decoded = originalDecode(input, ...rest);
		try {
			// Hanya pindai kalau input berupa byte utuh (Uint8Array). Decode
			// BERSARANG dari dalam Baileys (mis. isi FutureProofMessage)
			// menerima Reader yang menunjuk ke tengah buffer induk — byte
			// yang terbaca dari situ bukan pesan utuh, jadi jangan dipindai.
			// Pesan terluar selalu datang sebagai Uint8Array (lihat
			// decode-wa-message.js:266), dan parser di atas sudah mengurai
			// sub-message di dalamnya, jadi tidak ada yang hilang.
			if (!(input instanceof Uint8Array)) return decoded;
			const bytes = Buffer.from(input);
			if (!bytes.length) return decoded;
			const scan = scanMessageBytes(bytes);
			appendTypeLog(scan);
			const contentHash = crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 12);
			const isPlainText = scan.topLevelFields.length === 1 && scan.topLevelFields[0] === 1;
			if (scan.stickerFields) {
				saveSample(scan, decoded?.stickerMessage || null, contentHash);
			} else if (!isPlainText) {
				// Bukan teks biasa dan bukan stiker: simpan scan penuh apa pun
				// bentuknya. Ini yang menangkap sound sticker kalau ternyata
				// datang sebagai field Message lain atau terbungkus pesan lain.
				saveSample(scan, null, contentHash);
			}
		} catch {
			// Jangan pernah merusak penerimaan pesan karena penangkap.
		}
		return decoded;
	};
	console.log(
		"🔊 [SOUND-STICKER-CAPTURE] Aktif (v2: mencatat semua tipe pesan). Kirim sound sticker ASLI dari WhatsApp beta ke bot, " +
			"lalu ambil file hasil tangkapan di data/sound-sticker-samples/."
	);
	return true;
}

module.exports = {
	installSoundStickerCapture,
	SAMPLE_DIR,
	KNOWN_STICKER_FIELDS,
	parseFields,
	scanMessageBytes,
};
