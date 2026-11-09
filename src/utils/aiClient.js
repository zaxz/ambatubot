const axios = require('axios');

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
 * Menghasilkan balasan AI melalui Google Generative AI REST (Gemini) dengan fallback model otomatis.
 * @param {Object} param
 * @param {string} param.message - Teks pesan pengguna
 * @param {string} [param.botName] - Nama bot (opsional)
 * @param {Object} param.config - Konfigurasi bot (digunakan config.ai)
 * @returns {Promise<string>} Teks balasan AI
 * @throws {Error} Jika apiKey kosong, semua model gagal, atau konten kosong
 */
async function generateReply({ message, botName, config }) {
	const ai = config && config.ai;
	if (!ai || !ai.apiKey) {
		throw new Error('AI tidak dikonfigurasi: apiKey kosong');
	}

	const prefix = config.botPrefix || '.';
	const activeBotName = botName || config.botName || 'AmbatuBOT';
	const maxVideoSecs = config.sticker?.maxVideoDurationSeconds || 9;
	const ownerName = config.ownerName || config.sticker?.packAuthor || 'callmejeki';
	const ownerNumber = (config.ownerNumbers && config.ownerNumbers[0]) || '';
	const botKnowledge = [
		`[PENGETAHUAN SISTEM & FITUR BOT]`,
		`Identitas: Bot WhatsApp "${activeBotName}" (prefix perintah: "${prefix}").`,
		`ATURAN FORMAT & PENGGUNAAN FITUR:`,
		`- FORMAT RESMI WHATSAPP: DILARANG menggunakan tag HTML (<i>, <b>, <code>, <br>). Gunakan *tebal*, _miring_, ~coret~, dan \`\`\`monospace\`\`\`. Gunakan satu bintang (*teks*) untuk tebal, JANGAN pakai dua bintang (**teks**).`,
		`- ATURAN BAHASA KETAT: Bahasa utama adalah Bahasa Indonesia. DILARANG menggunakan Bahasa Jawa jika pengguna chat dalam Bahasa Indonesia. HANYA balas dengan Bahasa Jawa jika pengguna jelas-jelas memakai kosakata Bahasa Jawa.`,
		`- IDENTITAS OWNER: Owner dan pembuat bot kamu bernama "${ownerName}"${ownerNumber ? ` (nomor WhatsApp: +${ownerNumber})` : ""}. Jika ada yang bertanya siapa owner bot, siapa pembuatnya, atau siapa yang punya bot, sebutkan nama owner kamu.`,
		`- JANGAN BERTELE-TELE: Hindari omelan/ceramah berlebihan di akhir respon (seperti "kecuali lu mau nanya...", "buang-buang kuota gue...", dll). Berikan jawaban yang padat dan tuntas.`,
		`- Dalam obrolan biasa, JANGAN menyebutkan atau mempromosikan perintah bot jika tidak ditanya.`,
		`- HANYA jika pengguna secara spesifik bertanya tentang fitur atau cara pakai bot, jelaskan perintah resminya:`,
		`  • Bikin Stiker: Kirim atau balas foto/video (maks ${maxVideoSecs} detik) dengan caption "${prefix}s".`,
		`  • Bikin Stiker Meme: Kirim atau balas gambar dengan "${prefix}smeme teks atas | teks bawah".`,
		`  • Bikin Stiker Brat: Ketik "${prefix}brat <teks>".`,
		`  • Stiker jadi Gambar: Balas stiker dengan perintah "${prefix}toimg".`,
		`  • Cek Jadwal Kuliah: Ketik "${prefix}jadwal <kelas> [hari ini/besok/semua]" (contoh: "${prefix}jadwal 3p51 besok").`,
		`  • Cek PJ Matkul & Dosen: Ketik "${prefix}pj <kelas> <matkul>" (contoh: "${prefix}pj 3p51 statistik").`,
		`  • Menu & Bantuan: Ketik "${prefix}menu".`,
		`  • Cek Kecepatan/Server: Ketik "${prefix}ping" atau "${prefix}runtime".`,
	].join('\n');

	const basePrompt = ai.systemPrompt || 'Kamu adalah asisten WhatsApp yang toxic tapi membantu.';
	const fullSystemPrompt = `${basePrompt}\n\n${botKnowledge}`;

	const body = {
		systemInstruction: {
			parts: [{ text: fullSystemPrompt }],
		},
		contents: [
			{
				role: 'user',
				parts: [{ text: message }],
			},
		],
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
