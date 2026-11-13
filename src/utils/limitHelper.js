const fs = require("fs");
const path = require("path");
const config = require("../../config");

const DATA_DIR = path.join(__dirname, "../../data");
const DATA_FILE = path.join(DATA_DIR, "chatLimit.json");

/** Kuota default harian untuk non-owner. */
function defaultLimit() {
	const value = Number(config.chatLimit?.defaultLimit);
	return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 20;
}

/** Tanggal WIB (UTC+7) dalam format YYYY-MM-DD, dipakai sebagai penanda reset harian. */
function wibDateKey(date = new Date()) {
	const utc = date.getTime() + date.getTimezoneOffset() * 60000;
	const wib = new Date(utc + 7 * 3600000);
	const y = wib.getFullYear();
	const m = String(wib.getMonth() + 1).padStart(2, "0");
	const d = String(wib.getDate()).padStart(2, "0");
	return `${y}-${m}-${d}`;
}

/** Menormalkan nomor/JID menjadi digit saja. */
function normalizeUserId(input) {
	if (!input) return "";
	return String(input).split(":")[0].split("@")[0].replace(/[^0-9]/g, "");
}

let state = null;

function freshState() {
	return { date: wibDateKey(), users: {} };
}

function saveState() {
	if (!state) return;
	try {
		fs.mkdirSync(DATA_DIR, { recursive: true });
		const tmp = `${DATA_FILE}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(state), "utf8");
		fs.renameSync(tmp, DATA_FILE);
	} catch (err) {
		console.warn("[LIMIT] Gagal menyimpan data limit:", err.message);
	}
}

function loadState() {
	if (state) return state;
	try {
		const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
		state = parsed && typeof parsed === "object" && parsed.users ? parsed : freshState();
	} catch {
		state = freshState();
	}
	return state;
}

/** Reset seluruh kuota bila sudah masuk hari baru (00.00 WIB). */
function ensureToday() {
	const s = loadState();
	const today = wibDateKey();
	if (s.date !== today) {
		s.date = today;
		s.users = {};
		saveState();
	}
	return s;
}

function readEntry(s, userId) {
	const fallback = defaultLimit();
	const existing = s.users[userId];
	if (!existing) return { remaining: fallback, used: 0, limit: fallback };

	const limit = Number.isFinite(Number(existing.limit)) ? Math.max(0, Number(existing.limit)) : fallback;
	const remaining = Number.isFinite(Number(existing.remaining))
		? Math.max(0, Number(existing.remaining))
		: limit;
	return {
		remaining,
		used: Math.max(0, Number(existing.used) || 0),
		limit,
	};
}

/**
 * Melihat sisa limit seorang user tanpa mengubah apa pun.
 * @param {string} userId nomor WA / JID
 */
function getLimitInfo(userId) {
	const s = ensureToday();
	const key = normalizeUserId(userId);
	const entry = key ? readEntry(s, key) : { remaining: defaultLimit(), used: 0, limit: defaultLimit() };
	return {
		userId: key,
		remaining: entry.remaining,
		used: entry.used,
		limit: entry.limit,
		date: s.date,
	};
}

/**
 * Mengurangi satu kuota chat user (dipanggil setelah bot benar-benar membalas).
 * @param {string} userId
 * @returns {{remaining: number, used: number, limit: number}|null}
 */
function consumeLimit(userId) {
	const s = ensureToday();
	const key = normalizeUserId(userId);
	if (!key) return null;

	const entry = readEntry(s, key);
	if (entry.remaining <= 0) {
		s.users[key] = entry;
		saveState();
		return { remaining: 0, used: entry.used, limit: entry.limit };
	}

	entry.remaining -= 1;
	entry.used += 1;
	s.users[key] = entry;
	saveState();

	return { remaining: entry.remaining, used: entry.used, limit: entry.limit };
}

/**
 * Menetapkan / menambah kuota user oleh owner.
 * @param {string} userId
 * @param {number} value
 * @param {{add?: boolean}} [options] add=true untuk menambah dari sisa saat ini
 */
function setUserLimit(userId, value, { add = false } = {}) {
	const s = ensureToday();
	const key = normalizeUserId(userId);
	const amount = Math.floor(Number(value));
	if (!key || !Number.isFinite(amount) || amount < 0) return null;

	const entry = readEntry(s, key);
	if (add) {
		entry.remaining += amount;
		entry.limit += amount;
	} else {
		// Set absolut = kuota baru untuk hari ini (sisa penuh)
		entry.remaining = amount;
		entry.limit = amount;
		entry.used = 0;
	}
	s.users[key] = entry;
	saveState();

	return { userId: key, remaining: entry.remaining, used: entry.used, limit: entry.limit };
}

/** Daftar seluruh user yang punya catatan limit hari ini. */
function listUserLimits() {
	const s = ensureToday();
	return Object.entries(s.users)
		.map(([userId]) => {
			const entry = readEntry(s, userId);
			return { userId, remaining: entry.remaining, used: entry.used, limit: entry.limit };
		})
		.sort((a, b) => b.remaining - a.remaining || a.userId.localeCompare(b.userId));
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