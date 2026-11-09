const kabinetData = require("../assets/kabinet_3p51.json");

/**
 * Peta singkatan/alias untuk nama mata kuliah
 */
const aliasMap = {
	dsi: "Desain Sistem Informasi",
	desain: "Desain Sistem Informasi",
	sia: "Sistem Informasi Akuntansi",
	akuntansi: "Sistem Informasi Akuntansi",
	web: "Pemrograman Berbasis Web II",
	pbw: "Pemrograman Berbasis Web II",
	"web 2": "Pemrograman Berbasis Web II",
	"web ii": "Pemrograman Berbasis Web II",
	ai: "Pengembangan Kecerdasan Buatan",
	pkb: "Pengembangan Kecerdasan Buatan",
	kecerdasan: "Pengembangan Kecerdasan Buatan",
	dbms: "Pengelolaan DBMS",
	basisdata: "Pengelolaan DBMS",
	"basis data": "Pengelolaan DBMS",
	erp: "Fundamental ERP",
	ferp: "Fundamental ERP",
	jarkom: "Jaringan Komputer",
	jaringan: "Jaringan Komputer",
	inggris: "Bahasa Inggris II",
	"inggris 2": "Bahasa Inggris II",
	"inggris ii": "Bahasa Inggris II",
	bing: "Bahasa Inggris II",
	stat: "Statistik",
	statistik: "Statistik",
};

/**
 * Membersihkan format nomor telepon menjadi digit murni untuk link wa.me
 * @param {string} phone
 * @returns {string}
 */
function cleanWaNumber(phone) {
	if (!phone) return "";
	return phone.replace(/[^0-9]/g, "");
}

/**
 * Format panduan bantuan perintah .pj
 * @param {string} prefix
 * @returns {string}
 */
function formatHelp(prefix) {
	return `👥 *PANDUAN PENANGGUNG JAWAB (PJ) MATKUL*
━━━━━━━━━━━━━━━━━━━━━━━

*Format Penggunaan:*
• *${prefix}pj <kelas> <nama matkul>*
• *${prefix}pj <kelas> semua* _(lihat semua matkul & PJ)_

*Contoh Perintah:*
• *${prefix}pj 3p51 statistik*
• *${prefix}pj 3p51 web*
• *${prefix}pj 3p51 dsi*
• *${prefix}pj 3p51 jarkom*
• *${prefix}pj 3p51 semua*

💡 _Daftar singkatan matkul: statistik, dsi, sia, web, ai, dbms, erp, jarkom, inggris._`;
}

/**
 * Format detail satu mata kuliah beserta dosen dan PJ-nya
 */
function formatSingleMatkul(item, kelas, prefix) {
	const waClean = cleanWaNumber(item.dosen?.nomorTelepon);
	const waLink = waClean ? `https://wa.me/${waClean}` : "-";
	const institusi = kabinetData.kabinet?.institusi || "Institut Widya Pratama Pekalongan (IWIMA)";
	const namaKabinet = kabinetData.kabinet?.nama || "Kabinet Gendut";

	let text = `👥 *PENANGGUNG JAWAB (PJ) MATA KULIAH*\n`;
	text += `🏛️ _${institusi}_\n`;
	text += `🏷️ *Kelas:* ${kelas.toUpperCase()}\n`;
	text += `📘 *Mata Kuliah:* ${item.matkul}\n`;
	text += `━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

	text += `👨‍🏫 *DOSEN PENGAMPU:*\n`;
	text += `• *Nama:* ${item.dosen?.nama || "-"}\n`;
	text += `• 📞 *Nomor WA:* ${item.dosen?.nomorTelepon || "-"}\n`;
	if (waClean) {
		text += `• 💬 *Chat Langsung:* ${waLink}\n`;
	}
	text += `\n`;

	text += `👥 *PENANGGUNG JAWAB (PJ):*\n`;
	(item.pj || []).forEach((p, idx) => {
		const peranLabel = p.peran === "Koordinator" ? "PJ-1" : "PJ-2";
		text += `${idx + 1}. *${peranLabel}:*\n`;
		text += `   • *Nama:* ${p.nama}\n`;
		text += `   • *NIM:* ${p.nim}\n`;
	});

	text += `\n━━━━━━━━━━━━━━━━━━━━━━━\n`;
	text += `💡 _Cek PJ matkul lain: *${prefix}pj ${kelas} <nama matkul>*_\n`;
	text += `💡 _Daftar semua PJ: *${prefix}pj ${kelas} semua*_`;

	return text.trim();
}

/**
 * Format daftar lengkap seluruh mata kuliah dan PJ di kelas tersebut
 */
function formatAllMatkul(items, kelas, prefix) {
	const institusi = kabinetData.kabinet?.institusi || "Institut Widya Pratama Pekalongan (IWIMA)";
	const namaKabinet = kabinetData.kabinet?.nama || "Kabinet Gendut";

	let text = `👥 *DAFTAR LENGKAP PJ MATKUL — KELAS ${kelas.toUpperCase()}*\n`;
	text += `🏛️ _${institusi}_\n`;
	text += `🏷️ *Kabinet:* ${namaKabinet}\n`;
	text += `━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

	items.forEach((item, idx) => {
		const waClean = cleanWaNumber(item.dosen?.nomorTelepon);
		const waText = waClean ? `https://wa.me/${waClean}` : "-";

		text += `${idx + 1}. 📘 *${item.matkul}*\n`;
		text += `   • 👨‍🏫 *Dosen:* ${item.dosen?.nama || "-"} (${waText})\n`;

		const pj1 = (item.pj || []).find((p) => p.peran === "Koordinator");
		const pj2List = (item.pj || []).filter((p) => p.peran !== "Koordinator");

		if (pj1) {
			text += `   • *PJ-1:* ${pj1.nama} (${pj1.nim})\n`;
		}
		if (pj2List.length > 0) {
			const pj2Str = pj2List.map((a) => `${a.nama} (${a.nim})`).join(", ");
			text += `   • *PJ-2:* ${pj2Str}\n`;
		}
		text += `\n`;
	});

	text += `━━━━━━━━━━━━━━━━━━━━━━━\n`;
	text += `💡 _Cek detail 1 matkul: *${prefix}pj ${kelas} <nama matkul>*_`;

	return text.trim();
}

/**
 * Memproses perintah .pj <kelas> <matkul>
 * @param {string} text - Argumen perintah (misal: "3p51 statistik")
 * @param {string} prefix - Prefix bot
 * @returns {string} - Pesan respons teks
 */
function getPjMatkul(text, prefix = ".") {
	if (!text || !text.trim()) {
		return formatHelp(prefix);
	}

	const parts = text.trim().split(/\s+/);
	const rawKelas = parts[0];
	const queryMatkul = parts.slice(1).join(" ").trim().toLowerCase();

	const cleanKelas = rawKelas.toUpperCase();

	// Validasi apakah data kelas tersedia
	const availableKelas = (kabinetData.kabinet?.kelas || "3P51").toUpperCase();
	if (!cleanKelas.includes(availableKelas)) {
		return `⚠️ Data PJ matkul untuk kelas *${cleanKelas}* belum tersedia.\n\nSaat ini data yang tersedia adalah kelas *${availableKelas}* (${kabinetData.kabinet?.nama}).\n\nContoh: *${prefix}pj 3p51 statistik*`;
	}

	const listMatkul = kabinetData.penanggungJawabMatkul || [];

	// Jika tidak menyebutkan matkul atau mengetik "semua"
	if (!queryMatkul || queryMatkul === "semua" || queryMatkul === "all" || queryMatkul === "list") {
		return formatAllMatkul(listMatkul, rawKelas, prefix);
	}

	// Cari matkul berdasarkan alias atau kecocokan substring
	let matchedItem = null;
	if (aliasMap[queryMatkul]) {
		const targetName = aliasMap[queryMatkul].toLowerCase();
		matchedItem = listMatkul.find((m) => m.matkul.toLowerCase() === targetName);
	}

	if (!matchedItem) {
		matchedItem = listMatkul.find((m) => m.matkul.toLowerCase().includes(queryMatkul));
	}

	if (!matchedItem) {
		const daftarNamaMatkul = listMatkul.map((m) => `• ${m.matkul}`).join("\n");
		return `⚠️ Mata kuliah *"${queryMatkul}"* tidak ditemukan di kelas *${cleanKelas}*!\n\nDaftar mata kuliah yang tersedia:\n${daftarNamaMatkul}\n\nContoh: *${prefix}pj 3p51 statistik*`;
	}

	return formatSingleMatkul(matchedItem, rawKelas, prefix);
}

module.exports = {
	getPjMatkul,
};
