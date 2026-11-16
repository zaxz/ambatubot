const fs = require("fs");
const path = require("path");
const config = require("../../config");

const DATA_DIR = path.join(__dirname, "../../data");
const DB_FILE = path.join(DATA_DIR, "bot.db");
const HISTORY_LIMIT = 30; // jumlah pesan terakhir yang disimpan per percakapan
const HISTORY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 hari

// Node masih menandai modul SQLite sebagai eksperimental; sembunyikan hanya
// peringatan itu agar log bot tetap bersih tanpa menutupi warning lain.
const originalEmitWarning = process.emitWarning;
process.emitWarning = function (warning, ...args) {
	const text = typeof warning === "string" ? warning : warning?.message || "";
	if (text.includes("SQLite is an experimental feature")) return;
	return originalEmitWarning.call(process, warning, ...args);
};

const { DatabaseSync } = require("node:sqlite");

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_FILE);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS users (
	jid TEXT PRIMARY KEY,
	name TEXT,
	remaining INTEGER NOT NULL,
	daily_limit INTEGER NOT NULL,
	used INTEGER NOT NULL DEFAULT 0,
	reset_date TEXT NOT NULL,
	msg_count INTEGER NOT NULL DEFAULT 0,
	first_seen INTEGER NOT NULL,
	last_seen INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	chat_jid TEXT NOT NULL,
	user_jid TEXT NOT NULL,
	role TEXT NOT NULL,
	text TEXT NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages (chat_jid, id);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages (created_at);

CREATE TABLE IF NOT EXISTS groups (
	jid TEXT PRIMARY KEY,
	subject TEXT,
	members INTEGER,
	added_at INTEGER NOT NULL,
	last_seen INTEGER NOT NULL,
	active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS stats (
	key TEXT PRIMARY KEY,
	value INTEGER NOT NULL DEFAULT 0
);
`);

/** Kuota default harian untuk non-owner (mengikuti config). */
function defaultLimit() {
	const value = Number(config.chatLimit?.defaultLimit);
	return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 30;
}

/** Tanggal WIB (UTC+7) dalam format YYYY-MM-DD sebagai penanda reset harian. */
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

// ---------------------------------------------------------------------------
// User & limit harian
// ---------------------------------------------------------------------------

const stmtGetUser = db.prepare("SELECT * FROM users WHERE jid = ?");
const stmtUpsertLimit = db.prepare(`
	INSERT INTO users (jid, name, remaining, daily_limit, used, reset_date, msg_count, first_seen, last_seen)
	VALUES (?, NULL, ?, ?, ?, ?, 0, ?, ?)
	ON CONFLICT(jid) DO UPDATE SET
		remaining = excluded.remaining,
		daily_limit = excluded.daily_limit,
		used = excluded.used,
		reset_date = excluded.reset_date,
		last_seen = excluded.last_seen
`);
const stmtTouchUser = db.prepare(`
	INSERT INTO users (jid, name, remaining, daily_limit, used, reset_date, msg_count, first_seen, last_seen)
	VALUES (?, ?, ?, ?, 0, ?, 1, ?, ?)
	ON CONFLICT(jid) DO UPDATE SET
		name = COALESCE(excluded.name, users.name),
		msg_count = users.msg_count + 1,
		last_seen = excluded.last_seen
`);
const stmtListLimits = db.prepare(
		"SELECT jid, name, remaining, daily_limit, used FROM users WHERE reset_date = ? ORDER BY remaining DESC, jid ASC"
);
const stmtCountUsers = db.prepare("SELECT COUNT(*) AS n FROM users");

/**
 * Mencatat aktivitas user (nama, jumlah pesan, terakhir dilihat) tanpa
 * mengubah kuota limit yang sedang berjalan.
 */
function touchUser(userId, name = null) {
	const key = normalizeUserId(userId);
	if (!key) return null;
	// Owner tidak dicatat ke database (tidak pakai kuota & tidak perlu tersimpan)
	if ((config.ownerNumbers || []).includes(key)) return null;
	const now = Date.now();
	try {
		stmtTouchUser.run(key, name || null, defaultLimit(), defaultLimit(), wibDateKey(), now, now);
	} catch (err) {
		console.warn("[DB] Gagal mencatat user:", err.message);
	}
	return key;
}

/** Baris limit user, atau null bila belum pernah tercatat. */
function getLimitRow(userId) {
	const key = normalizeUserId(userId);
	if (!key) return null;
	try {
		return stmtGetUser.get(key) || null;
	} catch (err) {
		console.warn("[DB] Gagal membaca limit user:", err.message);
		return null;
	}
}

/** Menyimpan kuota limit user (nama & jumlah pesan dipertahankan). */
function saveLimit(userId, { remaining, limit, used, resetDate }) {
	const key = normalizeUserId(userId);
	if (!key) return null;
	const now = Date.now();
	const safeRemaining = Math.max(0, Math.floor(Number(remaining) || 0));
	const safeLimit = Math.max(0, Math.floor(Number(limit) || 0));
	const safeUsed = Math.max(0, Math.floor(Number(used) || 0));
	const safeDate = resetDate || wibDateKey();
	try {
		stmtUpsertLimit.run(key, safeRemaining, safeLimit, safeUsed, safeDate, now, now);
		bumpStat("limit_updates");
	} catch (err) {
		console.warn("[DB] Gagal menyimpan limit user:", err.message);
		return null;
	}
	return { userId: key, remaining: safeRemaining, limit: safeLimit, used: safeUsed, resetDate: safeDate };
}

/** Semua user yang tercatat pada tanggal tertentu (default hari ini, WIB). */
function listLimitRows(dateKey = wibDateKey()) {
	try {
		return stmtListLimits.all(dateKey).map((row) => ({
			userId: row.jid,
			name: row.name || null,
			remaining: Math.max(0, Number(row.remaining) || 0),
			limit: Math.max(0, Number(row.daily_limit) || 0),
			used: Math.max(0, Number(row.used) || 0),
		}));
	} catch (err) {
		console.warn("[DB] Gagal membaca daftar limit:", err.message);
		return [];
	}
}

/** Jumlah user yang pernah berinteraksi dengan bot. */
function countUsers() {
	try {
		return Number(stmtCountUsers.get()?.n) || 0;
	} catch {
		return 0;
	}
}

// ---------------------------------------------------------------------------
// Memori percakapan AI
// ---------------------------------------------------------------------------

const stmtInsertMessage = db.prepare(
	"INSERT INTO messages (chat_jid, user_jid, role, text, created_at) VALUES (?, ?, ?, ?, ?)"
);
const stmtTrimMessages = db.prepare(`
	DELETE FROM messages
	WHERE chat_jid = ?
	  AND id NOT IN (SELECT id FROM messages WHERE chat_jid = ? ORDER BY id DESC LIMIT ?)
`);
const stmtGetMessages = db.prepare(
	"SELECT role, text, created_at FROM messages WHERE chat_jid = ? ORDER BY id DESC LIMIT ?"
);
const stmtPruneMessages = db.prepare("DELETE FROM messages WHERE created_at < ?");
const stmtCountMessages = db.prepare("SELECT COUNT(*) AS n FROM messages");

/**
 * Menyimpan satu pesan percakapan dan memangkas riwayat agar hanya tersisa
 * `HISTORY_LIMIT` pesan terakhir untuk chat tersebut.
 */
function appendChatMessage(chatJid, userJid, role, text) {
	if (!chatJid || !text || (role !== "user" && role !== "model")) return;
	const cleaned = String(text).trim().slice(0, 450);
	if (!cleaned) return;
	const userId = normalizeUserId(userJid) || normalizeUserId(chatJid);
	try {
		stmtInsertMessage.run(String(chatJid), userId, role, cleaned, Date.now());
		stmtTrimMessages.run(String(chatJid), String(chatJid), HISTORY_LIMIT);
		bumpStat(role === "model" ? "ai_replies" : "chat_messages");
	} catch (err) {
		console.warn("[DB] Gagal menyimpan pesan:", err.message);
	}
}

/** 30 pesan terakhir pada satu percakapan, urut lama → baru. */
function getChatHistory(chatJid, limit = HISTORY_LIMIT) {
	if (!chatJid) return [];
	try {
		const rows = stmtGetMessages.all(String(chatJid), Math.max(1, Math.min(limit, HISTORY_LIMIT)));
		return rows
			.reverse()
			.map((row) => ({ role: row.role === "model" ? "model" : "user", text: row.text }));
	} catch (err) {
		console.warn("[DB] Gagal membaca riwayat chat:", err.message);
		return [];
	}
}

/** Hapus riwayat sebuah chat (dipakai untuk reset manual bila diperlukan). */
function clearChatHistory(chatJid) {
	try {
		db.prepare("DELETE FROM messages WHERE chat_jid = ?").run(String(chatJid));
	} catch (err) {
		console.warn("[DB] Gagal menghapus riwayat chat:", err.message);
	}
}

function countMessages() {
	try {
		return Number(stmtCountMessages.get()?.n) || 0;
	} catch {
		return 0;
	}
}

// ---------------------------------------------------------------------------
// Grup
// ---------------------------------------------------------------------------

const stmtUpsertGroup = db.prepare(`
	INSERT INTO groups (jid, subject, members, added_at, last_seen, active)
	VALUES (?, ?, ?, ?, ?, 1)
	ON CONFLICT(jid) DO UPDATE SET
		subject = COALESCE(excluded.subject, groups.subject),
		members = COALESCE(excluded.members, groups.members),
		last_seen = excluded.last_seen,
		active = 1
`);
const stmtDeactivateGroup = db.prepare(
	"UPDATE groups SET active = 0, last_seen = ? WHERE jid = ?"
);
const stmtInsertInactiveGroup = db.prepare(`
	INSERT INTO groups (jid, subject, members, added_at, last_seen, active)
	VALUES (?, ?, ?, ?, ?, 0)
	ON CONFLICT(jid) DO UPDATE SET active = 0, last_seen = excluded.last_seen, subject = COALESCE(excluded.subject, groups.subject)
`);
const stmtListGroups = db.prepare(
	"SELECT jid, subject, members, last_seen FROM groups WHERE active = 1 ORDER BY subject COLLATE NOCASE ASC, jid ASC"
);
const stmtGetGroup = db.prepare("SELECT * FROM groups WHERE jid = ?");

function upsertGroup(jid, subject = null, members = null) {
	if (!jid) return null;
	const now = Date.now();
	try {
		const existing = stmtGetGroup.get(String(jid));
		const safeMembers = Number.isFinite(Number(members)) ? Number(members) : null;
		stmtUpsertGroup.run(String(jid), subject || null, safeMembers, existing?.added_at || now, now);
		return true;
	} catch (err) {
		console.warn("[DB] Gagal menyimpan grup:", err.message);
		return false;
	}
}

function deactivateGroup(jid, subject = null) {
	if (!jid) return false;
	const now = Date.now();
	try {
		const res = stmtDeactivateGroup.run(now, String(jid));
		if (!res.changes) stmtInsertInactiveGroup.run(String(jid), subject, null, now, now);
		return true;
	} catch (err) {
		console.warn("[DB] Gagal menonaktifkan grup:", err.message);
		return false;
	}
}

/** Daftar grup aktif yang tersimpan di database. */
function listGroups() {
	try {
		return stmtListGroups.all().map((row) => ({
			jid: row.jid,
			subject: row.subject,
			members: row.members,
			lastSeen: row.last_seen,
		}));
	} catch (err) {
		console.warn("[DB] Gagal membaca daftar grup:", err.message);
		return [];
	}
}

// ---------------------------------------------------------------------------
// Statistik ringan
// ---------------------------------------------------------------------------

const stmtBumpStat = db.prepare(`
	INSERT INTO stats (key, value) VALUES (?, ?)
	ON CONFLICT(key) DO UPDATE SET value = value + excluded.value
`);
const stmtGetStats = db.prepare("SELECT key, value FROM stats");

function bumpStat(key, amount = 1) {
	if (!key) return;
	try {
		stmtBumpStat.run(String(key), Number(amount) || 1);
	} catch {
		// Statistik bersifat opsional, jangan ganggu alur utama
	}
}

function getStats() {
	try {
		const out = {};
		for (const row of stmtGetStats.all()) out[row.key] = Number(row.value) || 0;
		return out;
	} catch {
		return {};
	}
}

// ---------------------------------------------------------------------------
// Migrasi & pembersihan
// ---------------------------------------------------------------------------

/** Impor state limit lama (data/chatLimit.json) satu kali ke SQLite. */
function migrateLegacyLimitFile() {
	const legacyFile = path.join(DATA_DIR, "chatLimit.json");
	if (!fs.existsSync(legacyFile)) return;
	try {
		if (Number(stmtCountUsers.get()?.n) > 0) {
			fs.renameSync(legacyFile, `${legacyFile}.bak`);
			return;
		}
		const legacy = JSON.parse(fs.readFileSync(legacyFile, "utf8"));
		const users = legacy?.users || {};
		const today = wibDateKey();
		const isToday = legacy?.date === today;
		for (const [jid, entry] of Object.entries(users)) {
			const limit = Number(entry?.limit) || defaultLimit();
			saveLimit(jid, {
				remaining: isToday ? Number(entry?.remaining) || 0 : limit,
				limit,
				used: isToday ? Number(entry?.used) || 0 : 0,
				resetDate: today,
			});
		}
		fs.renameSync(legacyFile, `${legacyFile}.bak`);
		console.log(`[DB] Migrasi ${Object.keys(users).length} user limit dari chatLimit.json`);
	} catch (err) {
		console.warn("[DB] Migrasi limit lama gagal:", err.message);
	}
}

function pruneOldData() {
	try {
		const cutoff = Date.now() - HISTORY_MAX_AGE_MS;
		stmtPruneMessages.run(cutoff);
	} catch (err) {
		console.warn("[DB] Gagal membersihkan riwayat lama:", err.message);
	}
}

migrateLegacyLimitFile();
// Owner tidak perlu tersimpan di database (tidak pakai kuota, tidak perlu riwayat)
(config.ownerNumbers || []).forEach((o) => {
	try {
		db.prepare("DELETE FROM users WHERE jid = ?").run(String(o).replace(/\D/g, ""));
	} catch {
		// Diabaikan
	}
});
pruneOldData();

// Tutup database dengan rapi saat proses berhenti
process.once("exit", () => {
	try {
		db.close();
	} catch {
		// Sudah tertutup
	}
});

module.exports = {
	db,
	DB_FILE,
	HISTORY_LIMIT,
	defaultLimit,
	wibDateKey,
	normalizeUserId,
	touchUser,
	getLimitRow,
	saveLimit,
	listLimitRows,
	countUsers,
	appendChatMessage,
	getChatHistory,
	clearChatHistory,
	countMessages,
	upsertGroup,
	deactivateGroup,
	listGroups,
	bumpStat,
	getStats,
};
