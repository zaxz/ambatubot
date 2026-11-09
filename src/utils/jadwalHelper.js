const jadwalData = require("../assets/jadwal_lengkap.json");

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

module.exports = {
	getJadwalKuliah,
	getWibDate,
};
