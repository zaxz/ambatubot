const jadwalData = require("../assets/jadwal_lengkap.json");
const kabinetData = require("../assets/kabinet_3p51.json");

const daysMap = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];
const monthsMap = [
	"Januari", "Februari", "Maret", "April", "Mei", "Juni",
	"Juli", "Agustus", "September", "Oktober", "November", "Desember"
];

/**
 * Menghitung tanggal dan hari di zona waktu WIB (UTC+7)
 * @param {number} offsetDays
 */
function getWibDate(offsetDays = 0) {
	const now = new Date();
	const utc = now.getTime() + now.getTimezoneOffset() * 60000;
	const wibTime = new Date(utc + 7 * 3600000);
	if (offsetDays !== 0) {
		wibTime.setDate(wibTime.getDate() + offsetDays);
	}
	const dayName = daysMap[wibTime.getDay()];
	const dateStr = `${wibTime.getDate()} ${monthsMap[wibTime.getMonth()]} ${wibTime.getFullYear()}`;
	return {
		dayName,
		dateStr,
		dayIndex: wibTime.getDay(),
		full: `${dayName}, ${dateStr}`,
	};
}

/**
 * Format panduan bantuan perintah jadwal kuliah
 * @param {string} prefix
 */
function formatHelp(prefix) {
	const institusi = jadwalData.meta?.institusi || "Institut Widya Pratama";
	const semester = jadwalData.meta?.semesterAkademik || "Gasal";
	const tahun = jadwalData.meta?.tahunAkademik || "2026/2027";

	return `📚 *PANDUAN JADWAL KULIAH (IWIMA)*
🏛️ _${institusi}_
🗓️ Semester ${semester} TA ${tahun}
━━━━━━━━━━━━━━━━━━━━━━━

*Format Penggunaan:*
• *${prefix}jadwal <kelas> hari ini*
• *${prefix}jadwal <kelas> besok*
• *${prefix}jadwal <kelas> lusa*
• *${prefix}jadwal <kelas> <nama hari>*
• *${prefix}jadwal <kelas> semua* _(1 minggu penuh)_

*Contoh Perintah:*
• *${prefix}jadwal 3p51 hari ini*
• *${prefix}jadwal 3p51 besok*
• *${prefix}jadwal 3p51 lusa*
• *${prefix}jadwal 3p51 rabu*
• *${prefix}jadwal 3p51 semua*

💡 _Tip: Ketik tanpa hari (contoh: *${prefix}jadwal 3p51*) otomatis menampilkan jadwal hari ini._`;
}

/**
 * Memformat jadwal untuk 1 hari tertentu
 */
function formatSingleDaySchedule(kelasInput, targetDay, labelText, items, prefix) {
	const kelasDisplay = kelasInput.toUpperCase();
	const institusi = jadwalData.meta?.institusi || "Institut Widya Pratama Pekalongan";

	if (targetDay === "Sabtu" || targetDay === "Minggu") {
		return `📅 *JADWAL KULIAH — KELAS ${kelasDisplay}*
🏛️ _${institusi}_
🗓️ *Hari:* ${labelText}
━━━━━━━━━━━━━━━━━━━━━━━

🎉 *HARI LIBUR AKADEMIK!*
Tidak ada kegiatan perkuliahan reguler pada hari ${targetDay}. Selamat beristirahat!

💡 _Cek jadwal besok: *${prefix}jadwal ${kelasInput} besok*_
💡 _Cek jadwal seminggu: *${prefix}jadwal ${kelasInput} semua*_`;
	}

	if (!items || items.length === 0) {
		return `📅 *JADWAL KULIAH — KELAS ${kelasDisplay}*
🏛️ _${institusi}_
🗓️ *Hari:* ${labelText}
━━━━━━━━━━━━━━━━━━━━━━━

🎉 *TIDAK ADA JADWAL KULIAH!*
Kelas *${kelasDisplay}* tidak ada jadwal kuliah pada hari ${targetDay} (Kosong / Libur).

💡 _Cek jadwal besok: *${prefix}jadwal ${kelasInput} besok*_
💡 _Cek jadwal seminggu: *${prefix}jadwal ${kelasInput} semua*_`;
	}

	let text = `📅 *JADWAL KULIAH — KELAS ${kelasDisplay}*
🏛️ _${institusi}_
🗓️ *Hari:* ${labelText}
━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

	items.forEach((j, idx) => {
		const icon = j.jenis === "Praktikum" ? "💻" : "📘";
		text += `${idx + 1}. ${icon} *${j.matkul}*\n`;
		text += `   • ⏰ *Jam:* ${j.jam || "-"} WIB\n`;
		text += `   • 🏛️ *Ruang:* ${j.ruang || "-"} (${j.jenis || "Teori"})\n`;
		if (j.dosen && j.dosen !== "gabung") {
			text += `   • 👨‍🏫 *Dosen:* ${j.dosen}\n`;
		}
		text += `   • 🏷️ *Kelas:* ${j.kelas}\n\n`;
	});

	text += `━━━━━━━━━━━━━━━━━━━━━━━\n`;
	text += `📊 *Total:* ${items.length} Mata Kuliah\n`;
	text += `💡 _Lihat jadwal besok: *${prefix}jadwal ${kelasInput} besok*_\n`;
	text += `💡 _Lihat jadwal seminggu: *${prefix}jadwal ${kelasInput} semua*_`;

	return text.trim();
}

/**
 * Memformat jadwal untuk 1 minggu penuh
 */
function formatFullWeekSchedule(kelasInput, items, prefix) {
	const kelasDisplay = kelasInput.toUpperCase();
	const institusi = jadwalData.meta?.institusi || "Institut Widya Pratama Pekalongan";
	const semester = jadwalData.meta?.semesterAkademik || "Gasal";
	const tahun = jadwalData.meta?.tahunAkademik || "2026/2027";

	if (!items || items.length === 0) {
		return `⚠️ Tidak ditemukan jadwal untuk kelas *${kelasDisplay}*!`;
	}

	const daysOrder = ["Senin", "Selasa", "Rabu", "Kamis", "Jumat"];
	const byDay = {};
	for (const d of daysOrder) byDay[d] = [];

	items.forEach((item) => {
		if (byDay[item.hari]) {
			byDay[item.hari].push(item);
		}
	});

	let text = `📅 *JADWAL KULIAH LENGKAP — KELAS ${kelasDisplay}*
🏛️ _${institusi}_
🗓️ Semester ${semester} TA ${tahun}
━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

	let activeDaysCount = 0;
	for (const day of daysOrder) {
		const dayItems = byDay[day];
		if (dayItems.length > 0) {
			activeDaysCount++;
			text += `📌 *${day.toUpperCase()}* (${dayItems.length} Matkul)\n`;
			dayItems.forEach((j) => {
				const icon = j.jenis === "Praktikum" ? "💻" : "📘";
				text += `• ${j.jam || "-"} | ${icon} *${j.matkul}* [${j.ruang || "-"}] (${j.kelas})\n`;
			});
			text += `\n`;
		}
	}

	text += `━━━━━━━━━━━━━━━━━━━━━━━\n`;
	text += `📊 *Total:* ${items.length} Mata Kuliah (${activeDaysCount} hari perkuliahan aktif)\n`;
	text += `💡 _Cek hari ini: *${prefix}jadwal ${kelasInput} hari ini*_\n`;
	text += `💡 _Cek besok: *${prefix}jadwal ${kelasInput} besok*_`;

	return text.trim();
}

/**
 * Fungsi utama untuk memproses perintah jadwal kuliah
 * @param {string} text - Argumen perintah (misal: "3p51 hari ini", "3p51 besok", "3p51")
 * @param {string} prefix - Prefix bot (default: ".")
 * @returns {string} - Pesan balasan teks yang sudah diformat
 */
function getJadwalKuliah(text, prefix = ".") {
	if (!text || !text.trim()) {
		return formatHelp(prefix);
	}

	const parts = text.trim().split(/\s+/);
	const rawKelas = parts[0];
	const rest = parts.slice(1).join(" ").toLowerCase().trim();

	const cleanKelas = rawKelas.toUpperCase();

	// Cek apakah kelas terdaftar di meta database
	const daftarKelas = jadwalData.meta?.daftarKelas || [];
	const classExists = daftarKelas.some((k) => k.toUpperCase().includes(cleanKelas));
	if (!classExists) {
		const contohKelas = daftarKelas.slice(0, 10).join(", ");
		return `⚠️ Kelas *${cleanKelas}* tidak ditemukan dalam jadwal!\n\nPastikan format kelas sesuai.\nContoh kelas: ${contohKelas}, dll.\n\nKetik *${prefix}jadwal* untuk melihat panduan.`;
	}

	let mode = "day"; // "day" | "all"
	let targetDay = null;
	let label = "";

	if (!rest || rest === "hari ini" || rest === "today" || rest === "now") {
		const d = getWibDate(0);
		targetDay = d.dayName;
		label = `Hari Ini (${d.full})`;
	} else if (rest === "besok" || rest === "tomorrow") {
		const d = getWibDate(1);
		targetDay = d.dayName;
		label = `Besok (${d.full})`;
	} else if (rest === "lusa") {
		const d = getWibDate(2);
		targetDay = d.dayName;
		label = `Lusa (${d.full})`;
	} else if (rest === "semua" || rest === "seminggu" || rest === "all" || rest === "full" || rest === "lengkap") {
		mode = "all";
		label = "Satu Minggu Penuh";
	} else {
		const cleanedDay = rest.replace(/^hari\s+/i, "").trim();
		const matchedDay = daysMap.find((d) => d.toLowerCase() === cleanedDay.toLowerCase());
		if (matchedDay) {
			targetDay = matchedDay;
			label = `Hari ${matchedDay}`;
		} else {
			return `⚠️ Hari "${rest}" tidak dikenali.\n\nPilihan yang tersedia:\n• *hari ini*\n• *besok*\n• *lusa*\n• *senin* s/d *jumat*\n• *semua* (jadwal seminggu)`;
		}
	}

	const all = jadwalData.jadwal || [];
	const filtered = all.filter((item) => {
		const k = (item.kelas || "").toUpperCase();
		const matchClass = k.includes(cleanKelas);
		const matchDay = targetDay ? (item.hari || "").toLowerCase() === targetDay.toLowerCase() : true;
		return matchClass && matchDay;
	});

	// Urutkan berdasarkan hari lalu jam mulai
	filtered.sort((a, b) => {
		if (a.hariIndex !== b.hariIndex) return (a.hariIndex || 0) - (b.hariIndex || 0);
		return (a.jamMulai || "").localeCompare(b.jamMulai || "");
	});

	if (mode === "all") {
		return formatFullWeekSchedule(cleanKelas, filtered, prefix);
	}

	return formatSingleDaySchedule(cleanKelas, targetDay, label, filtered, prefix);
}

/**
 * Alias panggilan/nama umum → potongan nama resmi di data jadwal.
 */
const DOSEN_ALIASES = {
	moses: "mosses",
	mosess: "mosses",
	widi: "widiyono",
	taufiq: "taufiqurrohman",
	tofiq: "taufiqurrohman",
	opik: "taufiqurrohman",
	titian: "tria",
	ipung: "ichwan",
	heru: "heru",
};

/**
 * Membuang gelar akademik dan tanda baca dari nama dosen.
 * @param {string} name
 * @returns {string} nama inti huruf kecil tanpa gelar
 */
function cleanDosenName(name) {
	if (!name) return "";
	return String(name)
		.replace(/\b(dr|prof)\.?\s+/gi, "")
		.replace(/,\s*[a-z.\s]+/gi, " ")
		.replace(
			/\b(st|skm|se|spd|mpd|mkom|skom|mm|mhum|mcs|msi|mh|mipol|akt|s\.t|m\.kom|s\.kom|m\.pd|s\.pd|s\.e|m\.m|m\.hum|m\.cs|m\.si|m\.h|s\.si|m\.si\.akt)\b/gi,
			" "
		)
		.replace(/[^a-zA-Z\s]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
}

/**
 * Kata yang bukan bagian nama dosen pada pertanyaan bebas,
 * mis. "pak moses lagi ngajar di kelas mana?".
 */
const QUERY_STOPWORDS =
	/\b(pak|bapak|bu|ibu|dosen|pengajar|guru|lagi|sedang|ngajar|mengajar|ajar|mengajar|di|kelas|mana|apa|saja|aja|jadwal|kuliah|matkul|mata|hari|ini|besok|lusa|kapan|ruang|siapa|yang|ada|kah|tolong|cek|info|tanya|soal|dan|juga|sekarang|jam|berapa|semua)\b/gi;

/**
 * Mengelompokkan seluruh entri jadwal per nama dosen (di-cache sekali).
 * @returns {Map<string, Array<Object>>}
 */
const dosenScheduleMap = (() => {
	const map = new Map();
	for (const item of jadwalData.jadwal || []) {
		const dosen = (item.dosen || "").trim();
		if (!dosen || dosen.toLowerCase() === "gabung") continue;
		if (!map.has(dosen)) map.set(dosen, []);
		map.get(dosen).push(item);
	}
	return map;
})();

/**
 * Mencari nomor WA dosen pada data kabinet berdasarkan nama (butuh minimal 2 kata sama).
 * @param {string} dosenName
 */
function findDosenContact(dosenName) {
	const norm = cleanDosenName(dosenName).split(" ").filter((t) => t.length >= 3);
	if (norm.length === 0) return null;

	for (const kd of kabinetData.dosen || []) {
		const kdNorm = cleanDosenName(kd.nama);
		if (kdNorm === cleanDosenName(dosenName)) return kd.nomorTelepon || null;
		const kdTokens = new Set(kdNorm.split(" ").filter((t) => t.length >= 3));
		const shared = norm.filter((t) => kdTokens.has(t)).length;
		if (shared >= 2) return kd.nomorTelepon || null;
	}
	return null;
}

/**
 * Mencari dosen dan seluruh jadwal mengajarnya di SEMUA kelas.
 * @param {string} rawQuery - teks bebas, mis. "pak moses lagi ngajar di kelas mana"
 * @returns {Array<{dosen: string, kontak: string|null, score: number, schedules: Array<Object>}>}
 */
function searchDosenSchedules(rawQuery) {
	if (!rawQuery || !String(rawQuery).trim()) return [];

	const cleaned = String(rawQuery)
		.toLowerCase()
		.replace(QUERY_STOPWORDS, " ")
		.replace(/[^a-z0-9\s]/g, " ")
		.replace(/\s+/g, " ")
		.trim();

	const rawTokens = cleaned.split(" ").filter((t) => t.length >= 3);
	if (rawTokens.length === 0) return [];

	const queryTerms = [];
	for (const token of rawTokens) {
		queryTerms.push(token);
		if (DOSEN_ALIASES[token]) queryTerms.push(DOSEN_ALIASES[token]);
	}

	const matches = [];
	for (const [dosenName, items] of dosenScheduleMap.entries()) {
		const normTokens = cleanDosenName(dosenName)
			.split(" ")
			.filter((t) => t.length >= 3);

		let score = 0;
		for (const qTok of queryTerms) {
			for (const nTok of normTokens) {
				if (nTok === qTok) score += 10;
				else if (nTok.startsWith(qTok) || (qTok.length >= 4 && qTok.startsWith(nTok))) score += 6;
				else if (nTok.includes(qTok) || (qTok.length >= 4 && qTok.includes(nTok))) score += 3;
			}
		}

		if (score <= 0) continue;

		matches.push({
			dosen: dosenName,
			kontak: findDosenContact(dosenName),
			score,
			schedules: [...items].sort(
				(a, b) =>
					(a.hariIndex || 0) - (b.hariIndex || 0) ||
					(a.jamMulai || "").localeCompare(b.jamMulai || "")
			),
		});
	}

	matches.sort((a, b) => b.score - a.score || b.schedules.length - a.schedules.length);
	return matches;
}

/**
 * Format jawaban teks "dosen mengajar di kelas mana".
 * @param {string} query - nama/kata kunci dosen
 * @param {string} [prefix]
 * @returns {string}
 */
function formatDosenInfo(query, prefix = ".") {
	const institusi = jadwalData.meta?.institusi || "Institut Widya Pratama Pekalongan (IWIMA)";
	const keyword = String(query || "").trim();
	const matches = searchDosenSchedules(keyword);

	if (matches.length === 0) {
		return `⚠️ Dosen dengan kata kunci *"${keyword}"* tidak ditemukan di data jadwal.\n\n` +
			`💡 _Coba pakai nama panggilan, contoh: *${prefix}dosen moses*, *${prefix}dosen widiyono*, *${prefix}dosen eko*._`;
	}

	const primary = matches[0];
	const classes = [...new Set(primary.schedules.map((s) => s.kelas))];

	let text = `👨‍🏫 *JADWAL MENGAJAR DOSEN (SEMUA KELAS)*\n`;
	text += `🏛️ _${institusi}_\n`;
	text += `━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
	text += `• 👤 *Nama:* ${primary.dosen}\n`;
	if (primary.kontak) {
		const wa = primary.kontak.replace(/[^0-9]/g, "");
		text += `• 📞 *Nomor WA:* ${primary.kontak}\n`;
		text += `• 💬 *Chat:* https://wa.me/${wa}\n`;
	}
	text += `• 🏷️ *Mengajar:* ${classes.length} kelas (${classes.join(", ")})\n`;
	text += `• 📊 *Total:* ${primary.schedules.length} sesi\n\n`;

	text += `📚 *Rincian Jadwal:*\n`;
	primary.schedules.forEach((s, idx) => {
		const icon = s.jenis === "Praktikum" ? "💻" : "📘";
		text += `${idx + 1}. ${icon} *${s.matkul}*\n`;
		text += `   • 🏷️ *Kelas:* ${s.kelas}\n`;
		text += `   • 🗓️ *Waktu:* ${s.hari}, ${s.jam || "-"} WIB\n`;
		text += `   • 🏛️ *Ruang:* ${s.ruang || "-"} (${s.jenis || "Teori"})\n\n`;
	});

	if (matches.length > 1) {
		text += `━━━━━━━━━━━━━━━━━━━━━━━\n`;
		text += `🔍 *Dosen lain yang mungkin cocok:*\n`;
		text += matches
			.slice(1, 4)
			.map((m) => `• ${m.dosen} (${m.schedules.length} sesi)`)
			.join("\n");
		text += `\n\n`;
	}

	text += `━━━━━━━━━━━━━━━━━━━━━━━\n`;
	text += `💡 _Atau tanya bebas ke bot: "pak ${keyword} lagi ngajar di kelas mana?"_`;

	return text.trim();
}

/**
 * Daftar seluruh nama dosen yang ada di data jadwal (untuk konteks AI).
 * @returns {Array<string>}
 */
function getAllDosenNames() {
	return [...dosenScheduleMap.keys()].sort((a, b) => a.localeCompare(b));
}

module.exports = {
	getJadwalKuliah,
	getWibDate,
	searchDosenSchedules,
	formatDosenInfo,
	getAllDosenNames,
};
