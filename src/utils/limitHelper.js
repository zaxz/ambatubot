const db = require("./db");

// Catatan: data disimpan di SQLite (data/bot.db) sehingga kuota & riwayat user
// tetap ada setelah proses bot restart. Kuota direset berdasarkan tanggal WIB.

/** Kuota default harian untuk non-owner. */
function defaultLimit() {
	return db.defaultLimit();
}

/** Tanggal WIB (UTC+7) dalam format YYYY-MM-DD, dipakai sebagai penanda reset harian. */
function wibDateKey(date = new Date()) {
	return db.wibDateKey(date);
}

/** Menormalkan nomor/JID menjadi digit saja. */
function normalizeUserId(input) {
	return db.normalizeUserId(input);
}

/**
 * Nilai efektif untuk user: memakai baris tersimpan bila masih di hari yang sama,
 * kalau tidak (belum pernah chat / sudah lewat tengah malam) kembali ke kuota default.
 */
function effectiveLimit(userId) {
	const fallback = defaultLimit();
	const row = db.getLimitRow(userId);
	if (!row) return { remaining: fallback, used: 0, limit: fallback };
	if (row.reset_date !== wibDateKey()) return { remaining: fallback, used: 0, limit: fallback };
	return {
		remaining: Math.max(0, Number(row.remaining) || 0),
		used: Math.max(0, Number(row.used) || 0),
		limit: row.daily_limit === null || row.daily_limit === undefined ? fallback : Math.max(0, Number(row.daily_limit)),
	};
}

/**
 * Melihat sisa limit seorang user tanpa mengubah apa pun.
 * @param {string} userId nomor WA / JID
 */
function getLimitInfo(userId) {
	const key = normalizeUserId(userId);
	const entry = key ? effectiveLimit(key) : { remaining: defaultLimit(), used: 0, limit: defaultLimit() };
	return {
		userId: key,
		remaining: entry.remaining,
		used: entry.used,
		limit: entry.limit,
		date: wibDateKey(),
	};
}

/**
 * Mengurangi satu kuota chat user (dipanggil setelah bot benar-benar membalas).
 * @param {string} userId
 * @returns {{remaining: number, used: number, limit: number}|null}
 */
function consumeLimit(userId) {
	const key = normalizeUserId(userId);
	if (!key) return null;
	const entry = effectiveLimit(key);

	if (entry.remaining <= 0) {
		return { remaining: 0, used: entry.used, limit: entry.limit };
	}

	const saved = db.saveLimit(key, {
		remaining: entry.remaining - 1,
		limit: entry.limit,
		used: entry.used + 1,
		resetDate: wibDateKey(),
	});
	return saved ? { remaining: saved.remaining, used: saved.used, limit: saved.limit } : null;
}

/**
 * Mengatur kuota harian user (khusus owner).
 * @param {string} userId
 * @param {number} amount jumlah kuota
 * @param {{add?: boolean}} options add=true menambah dari sisa saat ini
 */
function setUserLimit(userId, amount, { add = false } = {}) {
	const key = normalizeUserId(userId);
	const value = Math.max(0, Math.floor(Number(amount) || 0));
	if (!key) return null;

	const entry = effectiveLimit(key);
	const next = add
		? { remaining: entry.remaining + value, limit: entry.limit + value, used: entry.used }
		: { remaining: value, limit: value, used: 0 };

	const saved = db.saveLimit(key, {
		remaining: next.remaining,
		limit: next.limit,
		used: next.used,
		resetDate: wibDateKey(),
	});
	if (!saved) return null;
	return { userId: saved.userId, remaining: saved.remaining, used: saved.used, limit: saved.limit };
}

/** Semua user yang sudah tercatat memakai kuota hari ini. */
function listUserLimits() {
	return db.listLimitRows(wibDateKey());
}

module.exports = {
	getLimitInfo,
	consumeLimit,
	setUserLimit,
	listUserLimits,
	normalizeUserId,
	defaultLimit,
	wibDateKey,
};
