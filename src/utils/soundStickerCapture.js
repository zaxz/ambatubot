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
 * dengan parser generik (tanpa skema). Kalau ada `stickerMessage`
 * (field 26), semua nomor field di dalamnya dicatat — termasuk field yang
 * belum dikenal Baileys. Hasilnya disimpan ke
 * `data/sound-sticker-samples/` (folder itu di-.gitignore, tidak ikut
 * ter-commit; ambil filenya lewat File Manager panel lalu kirim ke Muse).
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
function tryParseSubmessage(bytes) {
	try {
		const fields = parseFields(bytes, false);
		if (!fields.length) return null;
		if (fields.some((f) => f.field <= 0 || f.field > 100)) return null;
		return fields;
	} catch {
		return null;
	}
}

function parseFields(buf, recurseIntoSticker) {
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
			// Rekursi hanya ke arah yang relevan: dari Message ke stickerMessage
			// (field 26 di Message, WAProto.proto:2088), dan di dalam sticker
			// ke field yang belum dikenal.
			const shouldRecurse =
				(recurseIntoSticker && fieldNo === 26) ||
				(!recurseIntoSticker && !KNOWN_STICKER_FIELDS.has(fieldNo));
			if (shouldRecurse) {
				const children = tryParseSubmessage(bytes);
				if (children) entry.children = children;
				// Simpan bytes mentah field tak dikenal secara utuh (isinya
				// metadata kecil: mediaKey/directPath/durasi — bukan file audio).
				if (!recurseIntoSticker) entry.rawBase64 = bytes.toString("base64");
			}
			fields.push(entry);
		} else {
			fields.push({ field: fieldNo, wireType, value: "(wire type tidak dikenal, berhenti)" });
			break;
		}
	}
	return fields;
}

// Pindai byte Message mentah: kembalikan daftar field top-level, field
// stickerMessage, dan field stiker yang belum dikenal Baileys.
function scanMessageBytes(buffer) {
	const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
	const top = parseFields(buf, true);
	const sticker = top.find((f) => f.field === 26);
	const stickerFields = sticker?.children || null;
	const unknownStickerFields = stickerFields
		? stickerFields.filter((f) => !KNOWN_STICKER_FIELDS.has(f.field))
		: [];
	return { topLevelFields: top.map((f) => f.field), stickerFields, unknownStickerFields };
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

function saveSample(scan, decodedSticker) {
	try {
		fs.mkdirSync(SAMPLE_DIR, { recursive: true });
		const stickerHash = crypto
			.createHash("sha256")
			.update(JSON.stringify(scan.stickerFields || []))
			.digest("hex")
			.slice(0, 12);
		const existing = fs.readdirSync(SAMPLE_DIR).find((f) => f.endsWith(`-${stickerHash}.json`));
		if (existing) return path.join(SAMPLE_DIR, existing); // sampel yang sama sudah tersimpan
		const ts = new Date().toISOString().replace(/[:.]/g, "-");
		const file = path.join(SAMPLE_DIR, `${ts}-${stickerHash}.json`);
		const payload = {
			capturedAt: new Date().toISOString(),
			note: "Sampel stiker mentah (metadata proto saja, bukan file gambar/audio). Field stiker yang tidak dikenal Baileys = kandidat field audio sound sticker.",
			unknownStickerFields: scan.unknownStickerFields,
			topLevelFields: scan.topLevelFields,
			stickerFields: scan.stickerFields,
			decodedStickerKnownFields: decodedSticker
				? JSON.parse(JSON.stringify(decodedSticker, (k, v) => sanitizeForJson(v)))
				: null,
		};
		fs.writeFileSync(file, JSON.stringify(payload, null, 2), "utf8");
		console.log(
			`🔊 [SOUND-STICKER-CAPTURE] Stiker masuk tersimpan: ${file} | field tak dikenal: ` +
				(scan.unknownStickerFields.length
					? scan.unknownStickerFields.map((f) => f.field).join(", ")
					: "tidak ada (stiker biasa / field audio terbuang di tempat lain)")
		);
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
			let bytes = null;
			if (input instanceof Uint8Array) bytes = Buffer.from(input);
			else if (input && input.buf instanceof Uint8Array) bytes = Buffer.from(input.buf);
			if (!bytes || !bytes.length) return decoded;
			const scan = scanMessageBytes(bytes);
			if (scan.stickerFields) {
				saveSample(scan, decoded?.stickerMessage || null);
			}
		} catch {
			// Jangan pernah merusak penerimaan pesan karena penangkap.
		}
		return decoded;
	};
	console.log(
		"🔊 [SOUND-STICKER-CAPTURE] Aktif. Kirim sound sticker ASLI dari WhatsApp beta ke bot, " +
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
