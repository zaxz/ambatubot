const axios = require('axios');
const { getWibDate, searchDosenSchedules, getAllDosenNames } = require('./jadwalHelper');
const jadwalData = require('../assets/jadwal_lengkap.json');
const kabinetData = require('../assets/kabinet_3p51.json');

/**
 * Membersihkan format teks AI agar sesuai 100% dengan standar chat WhatsApp
 * Mengonversi tag HTML (<b>, <i>, <br>) dan markdown (**) ke format resmi WhatsApp
 * @param {string} text
 * @returns {string}
 */
function sanitizeWhatsAppFormatting(text) {
	if (!text) return "";
	let str = text;
	str = str.replace(/<br\s*\/?>/gi, "\n");
	str = str.replace(/<\/?(b|strong)>/gi, "*");
	str = str.replace(/<\/?(i|em)>/gi, "_");
	str = str.replace(/<\/?(s|strike|del)>/gi, "~");
	str = str.replace(/<code[^>]*>(.*?)<\/code>/gi, "```$1```");
	str = str.replace(/<[^>]+>/g, ""); // bersihkan tag HTML sisa
	str = str.replace(/^#{1,6}\s*(.+)$/gm, "*$1*");
	str = str.replace(/\*\*([^*]+)\*\*/g, "*$1*");
	return str.trim();
}

/**
 * Mengubah pesan akademik/kuliah yang relevan menjadi konteks ringkas untuk prompt AI.
 * Hanya disisipkan bila percakapan menyinggung jadwal, matkul, PJ, dosen, atau kode kelas.
 */
function buildAcademicContext(queryText) {
	if (!queryText) return '';

	const sections = [];

	// 1. Pertanyaan seputar dosen: cari di SEMUA kelas (bukan hanya 3P51)
	const dosenMatches = searchDosenSchedules(queryText);
	const dosenIntent = /\b(dosen|pak|bapak|bu|ibu|ngajar|mengajar|ajar|pengajar|guru)\b/i.test(queryText);

	const academicTrigger =
		/\b(jadwal|kuliah|matkul|mata kuliah|kelas|praktikum|teori|ruang|lab|dosen|pengajar|guru|ngajar|mengajar|ajar|pj|penanggung jawab|kabinet|pengurus|presiden|wakil|sekretaris|bendahara|3p51|statistik|jarkom|dbms|erp|dsi|sia|pbw|web|pkb|inggris)\b|\b[1-8][a-z]\d{2}\b/i;

	// Nama dosen yang cocok kuat (mis. "kalo bu amanah?") tetap diproses walau tanpa kata kunci akademik
	const strongDosenMatch = dosenMatches.length > 0 && dosenMatches[0].score >= 6;
	if (!academicTrigger.test(queryText) && !strongDosenMatch) return '';

	if (dosenMatches.length > 0) {
		const institusi = jadwalData.meta?.institusi || 'IWIMA';
		const topMatches = dosenMatches.slice(0, 3);

		for (const match of topMatches) {
			const classes = [...new Set(match.schedules.map((s) => s.kelas))];
			const schedLines = match.schedules.map(
				(s) =>
					`- Kelas ${s.kelas} | ${s.hari} (hariIndex ${s.hariIndex}) | ${s.jam || '-'} WIB | ${s.matkul} (${s.jenis || 'Teori'}, Ruang: ${s.ruang || '-'})`
			);
			const contact = match.kontak ? ` | Nomor WA: ${match.kontak}` : '';

			sections.push(
				`[DATA DOSEN & SELURUH JADWAL MENGAJARNYA DI SEMUA KELAS (${institusi})]\n` +
					`Dosen: ${match.dosen}${contact}\n` +
					`Mengajar di ${classes.length} kelas: ${classes.join(', ')}\n` +
					`Total ${match.schedules.length} sesi:\n${schedLines.join('\n')}`
			);
		}

		sections.push(
			`[PETUNJUK DOSEN — WAJIB DIPATUHI] Data dosen di atas HASIL PENCARIAN SISTEM dan otomatis benar; dosen tersebut ADA di data. ` +
				`DILARANG menjawab "tidak ada di database", dilarang mengarang daftar dosen lain, dan dilarang menyebut dosen/kelas di luar data ini. ` +
				`Untuk pertanyaan "tadi/lagi/sedang ngajar di kelas mana", bandingkan hari & jam di data dengan WIB sekarang (${getWibDate().full}); ` +
				`jika tidak ada sesi pada jam tersebut, sebutkan sesi terdekat (sebelum/sesudahnya) beserta kelas, ruang, dan matkulnya. ` +
				`Sebutkan SEMUA kelas yang diajar bila diminta daftar kelas.`
		);
	} else if (dosenIntent) {
		const names = getAllDosenNames();
		sections.push(
			`[DAFTAR NAMA DOSEN YANG ADA DI DATA (${names.length} orang)]\n${names.join('; ')}\n` +
				`[PETUNJUK DOSEN] Tidak ada nama yang cocok dari pencarian otomatis untuk kata kunci pada pesan terakhir. ` +
				`Periksa kembali daftar nama di atas secara manual (perhatikan kemiripan ejaan/nama panggilan). ` +
				`Jika memang tidak ada, katakan datanya belum tersedia di bot — DILARANG mengklaim "database hanya berisi dosen tertentu" dan dilarang mengarang nama.`
		);
	}

	const allClasses = jadwalData.meta?.daftarKelas || [];
	const mentionedCodes = queryText.toUpperCase().match(/\b[1-8][A-Z]\d{2}\b/g) || [];
	const targetClasses = [];

	for (const code of mentionedCodes) {
		if (allClasses.some((c) => c.toUpperCase().includes(code)) && !targetClasses.includes(code)) {
			targetClasses.push(code);
		}
		if (targetClasses.length >= 2) break;
	}

	// Default ke 3P51 hanya bila pertanyaan tidak menyebut kelas maupun dosen
	if (targetClasses.length === 0 && dosenMatches.length === 0) {
		targetClasses.push('3P51');
	}

	for (const cls of targetClasses) {
		const items = (jadwalData.jadwal || [])
			.filter((item) => (item.kelas || '').toUpperCase().includes(cls))
			.sort((a, b) => (a.hariIndex || 0) - (b.hariIndex || 0) || (a.jamMulai || '').localeCompare(b.jamMulai || ''));

		if (items.length > 0) {
			const lines = items.map(
				(j) => `- ${j.hari} | ${j.jam || '-'} WIB | ${j.matkul} (${j.jenis || 'Teori'}, ${j.ruang || '-'}, Dosen: ${j.dosen || '-'})`
			);
			sections.push(`[DATA JADWAL KELAS ${cls} (${jadwalData.meta?.institusi || 'IWIMA'})]\n${lines.join('\n')}`);
		}
	}

	const wantsKabinet = /\b(pj|penanggung jawab|kabinet|pengurus|presiden|wakil|sekretaris|bendahara)\b/i.test(queryText);
	if (targetClasses.includes('3P51') || wantsKabinet) {
		const pengurus = (kabinetData.pengurusInti || [])
			.map((p) => `${p.jabatan}: ${p.nama}`)
			.join(', ');
		const pjLines = (kabinetData.penanggungJawabMatkul || []).map((item) => {
			const pjNames = (item.pj || []).map((p) => `${p.nama} (${p.peran === 'Koordinator' ? 'PJ-1' : 'PJ-2'})`).join(', ');
			return `- ${item.matkul} | Dosen: ${item.dosen?.nama || '-'} (${item.dosen?.nomorTelepon || '-'}) | PJ: ${pjNames}`;
		});
		sections.push(`[DATA KABINET & PJ MATKUL 3P51 (${kabinetData.kabinet?.nama || 'Kabinet Gendut'})]\nPengurus Inti: ${pengurus}\n${pjLines.join('\n')}`);
	}

	return sections.join('\n\n');
}

/**
 * Menyusun array `contents` Gemini dengan role bergantian (`user` ↔ `model`) yang valid,
 * menggabungkan riwayat chat singkat, pesan kutipan (reply), dan gambar (Vision).
 */
function buildGeminiContents({ history = [], quotedContext, message, image }) {
	const normalized = [];
	for (const entry of history) {
		if (!entry || !entry.text) continue;
		const role = entry.role === 'model' ? 'model' : 'user';
		const last = normalized[normalized.length - 1];
		if (last && last.role === role) {
			last.text += `\n${entry.text}`;
		} else {
			normalized.push({ role, text: entry.text });
		}
	}

	// Gemini mengharuskan percakapan dimulai dengan role `user`
	while (normalized.length > 0 && normalized[0].role === 'model') {
		normalized.shift();
	}

	let trailingUserContext = '';
	if (normalized.length > 0 && normalized[normalized.length - 1].role === 'user') {
		trailingUserContext = normalized.pop().text;
	}

	const contents = normalized.map((item) => ({
		role: item.role,
		parts: [{ text: item.text }],
	}));

	const currentSections = [];
	if (trailingUserContext) {
		currentSections.push(`[Konteks obrolan sebelumnya]\n${trailingUserContext}`);
	}
	if (quotedContext && quotedContext.text) {
		const label = quotedContext.sender ? `dari ${quotedContext.sender}` : 'yang dikutip';
		currentSections.push(`[Pesan ${label} yang sedang dibalas]:\n"${quotedContext.text}"`);
	}
	currentSections.push(message || (image ? 'Tolong lihat dan jelaskan gambar ini.' : ''));

	const currentParts = [];
	if (image && image.data && image.mimeType) {
		currentParts.push({
			inlineData: {
				mimeType: image.mimeType,
				data: image.data,
			},
		});
	}
	currentParts.push({ text: currentSections.filter(Boolean).join('\n\n') });

	contents.push({
		role: 'user',
		parts: currentParts,
	});

	return contents;
}

/**
 * Menghasilkan balasan AI melalui Google Generative AI REST (Gemini) dengan fallback model otomatis.
 * Mendukung riwayat chat singkat, konteks pesan kutipan, gambar (Vision), serta data jadwal/PJ.
 * @param {Object} param
 * @param {string} param.message - Teks pesan pengguna
 * @param {string} [param.senderName] - Nama pengirim pesan
 * @param {string} [param.groupName] - Nama grup (opsional)
 * @param {Array<{role: string, text: string}>} [param.history] - Riwayat obrolan terbaru
 * @param {{sender?: string, text: string}|null} [param.quotedContext] - Konteks pesan yang di-reply
 * @param {{mimeType: string, data: string}|null} [param.image] - Gambar base64 untuk Gemini Vision
 * @param {string} [param.botName] - Nama bot (opsional)
 * @param {Object} param.config - Konfigurasi bot (digunakan config.ai)
 * @returns {Promise<string>} Teks balasan AI
 */
async function generateReply({ message, senderName, groupName, history = [], quotedContext = null, image = null, botName, config }) {
	const ai = config && config.ai;
	if (!ai || !ai.apiKey) {
		throw new Error('AI tidak dikonfigurasi: apiKey kosong');
	}

	const prefix = config.botPrefix || '.';
	const activeBotName = botName || config.botName || 'AmbatuBOT';
	const maxVideoSecs = config.sticker?.maxVideoDurationSeconds || 9;
	const ownerName = config.ownerName || config.sticker?.packAuthor || 'callmejeki';
	const ownerNumber = (config.ownerNumbers && config.ownerNumbers[0]) || '';

	const today = getWibDate(0);
	const tomorrow = getWibDate(1);
	const dayAfter = getWibDate(2);
	const nowWib = new Date(Date.now() + new Date().getTimezoneOffset() * 60000 + 7 * 3600000);
	const jamWib = `${String(nowWib.getHours()).padStart(2, '0')}:${String(nowWib.getMinutes()).padStart(2, '0')}`;

	const recentText = history.slice(-3).map((h) => h.text).join(' ');
	const contextProbeText = [message, quotedContext?.text, recentText].filter(Boolean).join(' ');
	const academicContext = buildAcademicContext(contextProbeText);

	const botKnowledgeLines = [
		`[PENGETAHUAN SISTEM & FITUR BOT]`,
		`Identitas: Bot WhatsApp "${activeBotName}" (prefix perintah: "${prefix}").`,
		`Waktu Server Sekarang (WIB): ${today.full}, pukul ${jamWib} WIB | Besok: ${tomorrow.full} | Lusa: ${dayAfter.full}.`,
		groupName
			? `Konteks Lokasi: Sedang membalas di grup "${groupName}" untuk pengirim "${senderName || 'Teman'}".`
			: `Konteks Lokasi: Sedang membalas di chat pribadi dengan "${senderName || 'Teman'}".`,
		`ATURAN FORMAT & PENGGUNAAN FITUR:`,
		`- FORMAT RESMI WHATSAPP: DILARANG menggunakan tag HTML (<i>, <b>, <code>, <br>). Gunakan *tebal*, _miring_, ~coret~, dan \`\`\`monospace\`\`\`. Gunakan satu bintang (*teks*) untuk tebal, JANGAN pakai dua bintang (**teks**).`,
		`- ATURAN BAHASA KETAT: Bahasa utama adalah Bahasa Indonesia. DILARANG menggunakan Bahasa Jawa jika pengguna chat dalam Bahasa Indonesia. HANYA balas dengan Bahasa Jawa jika pengguna jelas-jelas memakai kosakata Bahasa Jawa.`,
		`- IDENTITAS OWNER: Owner dan pembuat bot kamu bernama "${ownerName}"${ownerNumber ? ` (nomor WhatsApp: +${ownerNumber})` : ''}. Jika ada yang bertanya siapa owner bot, siapa pembuatnya, atau siapa yang punya bot, sebutkan nama owner kamu.`,
		`- KONTEKS GAMBAR & REPLY: Jika pengguna melampirkan gambar atau membalas pesan tertentu, langsung baca dan jawab berdasarkan isi gambar atau pesan tersebut secara akurat.`,
		`- JANGAN BERTELE-TELE: Hindari omelan/ceramah berlebihan di akhir respon (seperti "kecuali lu mau nanya...", "buang-buang kuota gue...", dll). Berikan jawaban yang padat dan tuntas.`,
		`- Dalam obrolan biasa, JANGAN menyebutkan atau mempromosikan perintah bot jika tidak ditanya.`,
		`- HANYA jika pengguna secara spesifik bertanya tentang fitur atau cara pakai bot, jelaskan perintah resminya:`,
		`  • Bikin Stiker: Kirim atau balas foto/video (maks ${maxVideoSecs} detik) dengan caption "${prefix}s".`,
		`  • Bikin Stiker Meme: Kirim atau balas gambar dengan "${prefix}smeme teks atas | teks bawah".`,
		`  • Bikin Stiker Brat: Ketik "${prefix}brat <teks>".`,
		`  • Bikin Stiker Brat Bergerak: Ketik "${prefix}bratvid <teks>".`,
		`  • Stiker jadi Gambar: Balas stiker dengan perintah "${prefix}toimg".`,
		`  • iPhone Quoted Chat (IQC): Ketik "${prefix}iqc <teks>", "${prefix}iqc aku | <teks>" (bubble hijau kanan), atau balas chat dengan "${prefix}iqc".`,
		`  • Cek Jadwal Kuliah: Ketik "${prefix}jadwal <kelas> [hari ini/besok/semua]" (contoh: "${prefix}jadwal 3p51 besok").`,
		`  • Cek PJ Matkul & Dosen: Ketik "${prefix}pj <kelas> <matkul>" (contoh: "${prefix}pj 3p51 statistik").`,
		`  • Cari Dosen Lintas Kelas: Ketik "${prefix}dosen <nama>" (contoh: "${prefix}dosen moses"). Bisa juga ditanya bebas seperti "pak moses lagi ngajar di kelas mana?".`,
		`  • Menu & Bantuan: Ketik "${prefix}menu".`,
		`  • Cek Sisa Limit Chat: Ketik "${prefix}limit". Kuota harian dibatasi dan reset pukul 00.00 WIB; jika habis, pengguna harus chat owner untuk minta tambahan.`,
		`  • Cek Kecepatan/Server: Ketik "${prefix}ping" atau "${prefix}runtime".`,
	];

	if (academicContext) {
		botKnowledgeLines.push(
			`- DATA KULIAH TERVERIFIKASI: Gunakan data jadwal & PJ resmi di bawah ini untuk menjawab pertanyaan seputar jadwal/matkul/dosen/PJ. DILARANG mengarang jam, ruang, atau nama dosen di luar data ini:\n${academicContext}`
		);
	}

	const basePrompt = ai.systemPrompt || 'Kamu adalah asisten WhatsApp yang toxic tapi membantu.';
	const fullSystemPrompt = `${basePrompt}\n\n${botKnowledgeLines.join('\n')}`;

	const body = {
		systemInstruction: {
			parts: [{ text: fullSystemPrompt }],
		},
		contents: buildGeminiContents({ history, quotedContext, message, image }),
		generationConfig: {
			temperature: typeof ai.temperature === 'number' ? ai.temperature : 0.7,
			maxOutputTokens: typeof ai.maxOutputTokens === 'number' ? ai.maxOutputTokens : 1500,
		},
		safetySettings: [
			{ category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
			{ category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
			{ category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
			{ category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
		],
	};

	// Daftar model yang dicoba secara berurutan jika model utama overload (503) atau tidak ditemukan (404)
	const primaryModel = ai.model || 'gemini-3.5-flash-lite';
	const candidateModels = Array.from(
		new Set([primaryModel, 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-flash-lite-latest', 'gemini-3.5-flash'].filter(Boolean))
	);

	let lastError = null;
	for (const model of candidateModels) {
		const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${ai.apiKey}`;
		try {
			const response = await axios.post(url, body, { timeout: 25000 });

			const candidates = response.data?.candidates;
			if (!candidates || candidates.length === 0) {
				continue;
			}

			// Gabungkan SELURUH parts agar respon panjang tidak terpotong di tengah jalan
			const parts = candidates[0].content?.parts || [];
			const fullText = parts
				.map((p) => p.text || "")
				.join("")
				.trim();

			if (fullText) {
				return sanitizeWhatsAppFormatting(fullText);
			}
		} catch (err) {
			lastError = err;
			const status = err.response?.status;
			const errMsg = err.response?.data?.error?.message || err.message;
			console.warn(`[AI] Model ${model} gagal (${status || 'timeout'}): ${errMsg}, mencoba fallback...`);
		}
	}

	const finalMsg = lastError?.response?.data?.error?.message || lastError?.message || 'Semua model Gemini gagal merespon';
	throw new Error(`Google AI gagal: ${finalMsg}`);
}

module.exports = {
	generateReply,
};
