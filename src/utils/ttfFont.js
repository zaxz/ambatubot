const fs = require("fs");
const path = require("path");

/**
 * Pembaca metrik font TrueType minimal.
 *
 * Hanya membaca cmap, hmtx, head, dan hhea: cukup untuk mengetahui lebar
 * (advance width) tiap huruf sehingga teks bisa ditata rata kanan-kiri
 * (justify) dengan posisi piksel yang presisi.
 */
class TtfFont {
	constructor(buffer) {
		this.buf = buffer;
		this.tables = new Map();

		const numTables = buffer.readUInt16BE(4);
		for (let i = 0; i < numTables; i++) {
			const rec = 12 + i * 16;
			const tag = buffer.toString("latin1", rec, rec + 4);
			this.tables.set(tag, {
				offset: buffer.readUInt32BE(rec + 8),
				length: buffer.readUInt32BE(rec + 12),
			});
		}

		const head = this._table("head");
		this.unitsPerEm = buffer.readUInt16BE(head.offset + 18) || 1024;

		const hhea = this._table("hhea");
		this.ascent = buffer.readInt16BE(hhea.offset + 4) / this.unitsPerEm;
		this.descent = Math.abs(buffer.readInt16BE(hhea.offset + 6)) / this.unitsPerEm;
		this.numOfMetrics = buffer.readUInt16BE(hhea.offset + 34);

		this.glyphCache = new Map();
		this.bboxCache = new Map();
		this._readCmap();
		this._readAdvances();
		this._readGlyphBounds();
	}

	_table(tag) {
		const table = this.tables.get(tag);
		if (!table) throw new Error(`Tabel font "${tag}" tidak ditemukan`);
		return table;
	}

	_readCmap() {
		const cmap = this._table("cmap");
		const base = cmap.offset;
		const count = this.buf.readUInt16BE(base + 2);

		// Urutkan preferensi: Unicode lanjutan dulu, lalu BMP
		const preference = [[3, 10], [0, 6], [0, 4], [3, 1], [0, 3], [0, 0]];
		let best = null;

		for (let i = 0; i < count; i++) {
			const rec = base + 4 + i * 8;
			const platformId = this.buf.readUInt16BE(rec);
			const encodingId = this.buf.readUInt16BE(rec + 2);
			const offset = base + this.buf.readUInt32BE(rec + 4);
			const format = this.buf.readUInt16BE(offset);
			if (format !== 4 && format !== 12) continue;

			const rank = preference.findIndex(([p, e]) => p === platformId && e === encodingId);
			if (rank === -1) continue;
			if (!best || rank < best.rank) best = { rank, offset, format };
		}

		if (!best) throw new Error("Subtable cmap Unicode tidak ditemukan");

		this.cmapFormat = best.format;
		this.cmapOffset = best.offset;

		if (best.format === 4) this._readCmapFormat4(best.offset);
		else this._readCmapFormat12(best.offset);
	}

	_readCmapFormat4(offset) {
		const buf = this.buf;
		const segCount = buf.readUInt16BE(offset + 6) / 2;
		const endOffset = offset + 14;
		const startOffset = endOffset + segCount * 2 + 2;
		const deltaOffset = startOffset + segCount * 2;
		const rangeOffset = deltaOffset + segCount * 2;

		this.segments = [];
		for (let i = 0; i < segCount; i++) {
			this.segments.push({
				end: buf.readUInt16BE(endOffset + i * 2),
				start: buf.readUInt16BE(startOffset + i * 2),
				delta: buf.readInt16BE(deltaOffset + i * 2),
				rangeOffsetPos: rangeOffset + i * 2,
				rangeOffset: buf.readUInt16BE(rangeOffset + i * 2),
			});
		}
	}

	_readCmapFormat12(offset) {
		const buf = this.buf;
		const numGroups = buf.readUInt32BE(offset + 12);
		this.groups = [];
		for (let i = 0; i < numGroups; i++) {
			const rec = offset + 16 + i * 12;
			this.groups.push({
				start: buf.readUInt32BE(rec),
				end: buf.readUInt32BE(rec + 4),
				startGlyph: buf.readUInt32BE(rec + 8),
			});
		}
	}

	_readAdvances() {
		const hmtx = this._table("hmtx");
		const count = this.numOfMetrics;
		this.advances = new Uint16Array(count);
		for (let i = 0; i < count; i++) {
			this.advances[i] = this.buf.readUInt16BE(hmtx.offset + i * 4);
		}
		this.defaultAdvance = count > 0 ? this.advances[count - 1] : 0;
	}

	_readGlyphBounds() {
		this.numGlyphs = 0;
		try {
			const maxp = this._table("maxp");
			this.numGlyphs = this.buf.readUInt16BE(maxp.offset + 4);

			const head = this._table("head");
			const longLoca = this.buf.readInt16BE(head.offset + 50) === 1;
			const loca = this._table("loca");
			const glyf = this._table("glyf");
			this.glyfOffset = glyf.offset;

			this.locaOffsets = new Array(this.numGlyphs + 1);
			for (let i = 0; i <= this.numGlyphs; i++) {
				this.locaOffsets[i] = longLoca
					? this.buf.readUInt32BE(loca.offset + i * 4)
					: this.buf.readUInt16BE(loca.offset + i * 2) * 2;
			}
		} catch (e) {
			// Font CFF (tanpa tabel glyf) tidak punya data bounding box
			this.numGlyphs = 0;
			this.locaOffsets = null;
		}
	}

	/**
	 * Batas vertikal glyph relatif terhadap baseline dalam satuan em.
	 * @returns {{ascent: number, descent: number}} 0 bila glyph kosong
	 */
	inkEm(char) {
		if (!this.locaOffsets) return { ascent: 0, descent: 0 };

		const glyph = this.glyphIndex(char);
		if (glyph === 0 || glyph >= this.numGlyphs) return { ascent: 0, descent: 0 };

		if (this.bboxCache.has(glyph)) return this.bboxCache.get(glyph);

		const start = this.locaOffsets[glyph];
		const end = this.locaOffsets[glyph + 1];
		let box = { ascent: 0, descent: 0 };
		if (end > start) {
			const offset = this.glyfOffset + start;
			box = {
				ascent: Math.max(0, this.buf.readInt16BE(offset + 8) / this.unitsPerEm),
				descent: Math.max(0, -this.buf.readInt16BE(offset + 4) / this.unitsPerEm),
			};
		}

		this.bboxCache.set(glyph, box);
		return box;
	}

	/** Batas vertikal seluruh teks relatif terhadap baseline (satuan em). */
	inkOf(text) {
		let ascent = 0;
		let descent = 0;
		for (const char of text) {
			const box = this.inkEm(char);
			if (box.ascent > ascent) ascent = box.ascent;
			if (box.descent > descent) descent = box.descent;
		}
		return { ascent, descent };
	}

	_glyphFromCmapFormat4(codePoint) {
		const buf = this.buf;
		for (const seg of this.segments) {
			if (codePoint > seg.end) continue;
			if (codePoint < seg.start) return 0;
			if (seg.rangeOffset === 0) {
				return (codePoint + seg.delta) & 0xffff;
			}
			const index = seg.rangeOffsetPos + seg.rangeOffset + (codePoint - seg.start) * 2;
			if (index + 1 >= buf.length) return 0;
			const raw = buf.readUInt16BE(index);
			return raw === 0 ? 0 : (raw + seg.delta) & 0xffff;
		}
		return 0;
	}

	_glyphFromCmapFormat12(codePoint) {
		let low = 0;
		let high = this.groups.length - 1;
		while (low <= high) {
			const mid = (low + high) >> 1;
			const group = this.groups[mid];
			if (codePoint < group.start) high = mid - 1;
			else if (codePoint > group.end) low = mid + 1;
			else return group.startGlyph + (codePoint - group.start);
		}
		return 0;
	}

	glyphIndex(char) {
		const codePoint = typeof char === "string" ? char.codePointAt(0) : char;
		if (this.glyphCache.has(codePoint)) return this.glyphCache.get(codePoint);

		const glyph =
			this.cmapFormat === 12
				? this._glyphFromCmapFormat12(codePoint)
				: this._glyphFromCmapFormat4(codePoint);

		this.glyphCache.set(codePoint, glyph);
		return glyph;
	}

	hasGlyph(char) {
		return this.glyphIndex(char) !== 0;
	}

	/** Lebar advance satu karakter dalam satuan em (1 = setinggi font). */
	advanceEm(char) {
		const glyph = this.glyphIndex(char);
		const units = glyph < this.advances.length ? this.advances[glyph] : this.defaultAdvance;
		return units / this.unitsPerEm;
	}

	/** Lebar advance satu karakter dalam piksel, dibulatkan seperti FreeType. */
	advancePx(char, fontSize) {
		return Math.round(this.advanceEm(char) * fontSize);
	}

	/** Lebar total teks dalam satuan em. */
	measureEm(text) {
		let total = 0;
		for (const char of text) total += this.advanceEm(char);
		return total;
	}

	/** Lebar total teks dalam piksel (akumulasi pembulatan per huruf). */
	measurePx(text, fontSize) {
		let total = 0;
		for (const char of text) total += this.advancePx(char, fontSize);
		return total;
	}
}

const fontCache = new Map();

/**
 * Memuat font dari disk sekali saja (di-cache per path).
 * @param {string} filePath
 * @returns {TtfFont}
 */
function loadFont(filePath) {
	const key = path.resolve(filePath);
	if (fontCache.has(key)) return fontCache.get(key);

	const font = new TtfFont(fs.readFileSync(key));
	fontCache.set(key, font);
	return font;
}

module.exports = {
	loadFont,
};
