require("dotenv").config();
const express = require("express");
const multer = require("multer");
const { createWorker } = require("tesseract.js");
const { Client } = require("@notionhq/client");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DB = {
  subjects: process.env.SUBJECTS_DB,
  studyLog: process.env.STUDY_LOG_DB,
  wrongQuestions: process.env.WRONG_QUESTIONS_DB,
  testRecords: process.env.TEST_RECORDS_DB,
  mockExams: process.env.MOCK_EXAMS_DB,
};

const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;

// 圖片直接存進 Notion（用官方 File Upload API），不落地到本機磁碟，
// 這樣不管伺服器重啟/重新部署，照片都不會不見。
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

async function uploadImageToNotion(buffer, filename, mimeType) {
  const createRes = await fetch("https://api.notion.com/v1/file_uploads", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({}),
  });
  const created = await createRes.json();
  if (!createRes.ok) throw new Error(created.message || "Notion 檔案上傳建立失敗");

  const form = new FormData();
  form.append("file", new Blob([buffer], { type: mimeType }), filename);
  const sendRes = await fetch(created.upload_url, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.NOTION_TOKEN}`, "Notion-Version": "2022-06-28" },
    body: form,
  });
  const sent = await sendRes.json();
  if (!sendRes.ok) throw new Error(sent.message || "Notion 檔案上傳傳送失敗");

  return created.id;
}

// 從 Notion 頁面的某個 Files 屬性抓出目前的簽署網址，下載成 Buffer 給 Gemini 用
async function fetchNotionFileBuffer(page, propName) {
  const file = page.properties[propName]?.files?.[0];
  const url = file?.file?.url || file?.external?.url;
  if (!url) return null;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下載圖片失敗（${propName}）`);
  const arrayBuffer = await res.arrayBuffer();
  return { buffer: Buffer.from(arrayBuffer), mimeType: file.file?.url ? "image/jpeg" : res.headers.get("content-type") || "image/jpeg" };
}

// 把圖片以 Gemini 多模態直接送去分析，回傳去除 Markdown 的純文字回饋
async function gradeImageWithGemini(buffer, mimeType, promptTemplate) {
  if (!genAI) throw new Error("尚未設定 GEMINI_API_KEY，請先在 .env 加上再重啟伺服器");
  const model = genAI.getGenerativeModel({ model: "gemini-flash-latest" });
  const result = await model.generateContent([
    { inlineData: { data: buffer.toString("base64"), mimeType } },
    { text: promptTemplate },
  ]);
  return stripMarkdown(result.response.text());
}

function extractScore(text, label) {
  const m = text.match(new RegExp(`${label}[:：]\\s*([\\d.]+)`));
  return m ? Number(m[1]) : null;
}

const PLAIN_TEXT_RULE = "用繁體中文回覆，純文字，不要使用任何 Markdown 語法（不要用 **、#、-、```這類符號）。";

// 各科專屬批改 rubric（「專屬解析設定」），對應到考卷紀錄裡的各個 Files/Number/RichText 欄位
const GRADE_BLOCKS = {
  essay1: {
    image: "作文一圖片",
    score: "作文一分數",
    feedback: "作文一回饋",
    scoreLabel: "分數",
    prompt: `你是大考中心國文作文閱卷老師，請依照學測寫作測驗評分規準，依下列四個面向逐項評論這篇作文的照片內容：
1. 立意取材：主旨是否明確、選材是否恰當
2. 結構組織：段落安排、起承轉合是否流暢
3. 遣詞造句：用字遣詞是否精準生動、句型是否有變化
4. 錯別字、格式及標點符號：是否有明顯錯誤

每項給簡短評語，最後綜合給一個 0-25 分的總分。最後另起一行，只寫「分數:X」（X 是總分數字，不要有其他文字）。${PLAIN_TEXT_RULE}`,
  },
  essay2: {
    image: "作文二圖片",
    score: "作文二分數",
    feedback: "作文二回饋",
    scoreLabel: "分數",
    prompt: `你是大考中心國文作文閱卷老師，請依照學測寫作測驗評分規準，依下列四個面向逐項評論這篇作文的照片內容：
1. 立意取材：主旨是否明確、選材是否恰當
2. 結構組織：段落安排、起承轉合是否流暢
3. 遣詞造句：用字遣詞是否精準生動、句型是否有變化
4. 錯別字、格式及標點符號：是否有明顯錯誤

每項給簡短評語，最後綜合給一個 0-25 分的總分。最後另起一行，只寫「分數:X」（X 是總分數字，不要有其他文字）。${PLAIN_TEXT_RULE}`,
  },
  mathWork: {
    image: "手寫題圖片",
    score: "手寫題正確度",
    feedback: "手寫題回饋",
    scoreLabel: "正確度",
    prompt: `你是數學科老師，請逐步驟轉錄這張照片裡的手寫解題過程，並：
1. 依序列出每一個步驟在做什麼
2. 標出從哪一步開始出錯（如果有錯的話）
3. 判斷錯誤是「計算錯誤」還是「觀念錯誤」
4. 給出修正建議

最後另起一行，只寫「正確度:X」（X 是 0-100 的整數，代表這份解題過程整體的正確程度百分比，不要有其他文字）。${PLAIN_TEXT_RULE}`,
  },
  englishEssay: {
    image: "英文作文圖片",
    score: "英文作文分數",
    feedback: "英文作文回饋",
    scoreLabel: "分數",
    prompt: `你是學測英文寫作閱卷老師，請依照學測英文寫作評分規準，依下列面向逐項評論這篇作文的照片內容：
1. 內容：是否切題、內容是否充實
2. 組織：段落安排、句子銜接是否流暢
3. 文法句構：文法是否正確、句型是否多樣
4. 字彙拼字：用字是否恰當、拼字是否正確

每項給簡短評語（可中英夾雜），最後綜合給一個 0-20 分的總分。最後另起一行，只寫「分數:X」（X 是總分數字，不要有其他文字）。${PLAIN_TEXT_RULE}`,
  },
  englishWriting: {
    image: "英文手寫圖片",
    score: null,
    feedback: "英文手寫回饋",
    scoreLabel: null,
    prompt: `你是英文科老師，這張照片是學生的英文手寫作答（可能是句子改寫、翻譯或簡答）。請逐題檢查文法、用字、拼字是否正確，指出錯誤並給出修正建議，用簡短清楚的方式呈現。${PLAIN_TEXT_RULE}`,
  },
};

const app = express();
app.use(express.json());
app.use(express.static("public"));

function titleOf(page, prop) {
  return page.properties[prop]?.title?.[0]?.plain_text || "";
}
// 保險起見，把 AI 回覆裡可能殘留的 Markdown 符號清掉，確保前端拿到的是純文字
function stripMarkdown(text) {
  return text
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```/g, ""))
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/^\s*[-*+]\s+/gm, "・")
    .replace(/^\s*>\s?/gm, "")
    .trim();
}

function selectOf(page, prop) {
  return page.properties[prop]?.select?.name || null;
}
function numberOf(page, prop) {
  return page.properties[prop]?.number ?? null;
}
function fileUrlOf(page, prop) {
  const f = page.properties[prop]?.files?.[0];
  if (!f) return null;
  return f.external?.url || f.file?.url || null;
}
function rollupNumberOf(page, prop) {
  const r = page.properties[prop]?.rollup;
  if (!r) return null;
  if (r.type === "number") return r.number;
  if (r.type === "array" && r.array.length) {
    const nums = r.array.map((v) => v.number ?? v.formula?.number).filter((v) => v != null);
    if (!nums.length) return null;
    return nums.reduce((a, b) => a + b, 0) / nums.length;
  }
  return null;
}

// 科目進度表：清單 + rollup 統計
app.get("/api/subjects", async (req, res) => {
  try {
    const result = await notion.databases.query({ database_id: DB.subjects });
    const items = result.results.map((p) => ({
      id: p.id,
      unit: titleOf(p, "單元"),
      subject: selectOf(p, "科目"),
      status: selectOf(p, "狀態"),
      mastery: numberOf(p, "熟悉度"),
      lastReviewed: p.properties["最後複習日期"]?.date?.start || null,
      studyHours: rollupNumberOf(p, "累積讀書時數"),
      accuracy: rollupNumberOf(p, "平均正確率"),
      reviewRate: rollupNumberOf(p, "錯題複習率"),
    }));
    res.json(items);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 新增科目單元
app.post("/api/subjects", async (req, res) => {
  try {
    const { unit, subject, status, mastery } = req.body;
    const page = await notion.pages.create({
      parent: { database_id: DB.subjects },
      properties: {
        單元: { title: [{ text: { content: unit } }] },
        科目: subject ? { select: { name: subject } } : undefined,
        狀態: status ? { select: { name: status } } : undefined,
        熟悉度: mastery != null ? { number: Number(mastery) } : undefined,
      },
    });
    res.json({ id: page.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 更新科目單元
app.patch("/api/subjects/:id", async (req, res) => {
  try {
    const { unit, subject, status, mastery } = req.body;
    const properties = {};
    if (unit != null) properties["單元"] = { title: [{ text: { content: unit } }] };
    if (subject != null) properties["科目"] = { select: { name: subject } };
    if (status != null) properties["狀態"] = { select: { name: status } };
    if (mastery != null && mastery !== "") properties["熟悉度"] = { number: Number(mastery) };
    const page = await notion.pages.update({ page_id: req.params.id, properties });
    res.json({ id: page.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 刪除（封存）科目單元
app.delete("/api/subjects/:id", async (req, res) => {
  try {
    await notion.pages.update({ page_id: req.params.id, archived: true });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function createStudyLog({ summary, date, subject, unitId, hours }) {
  const page = await notion.pages.create({
    parent: { database_id: DB.studyLog },
    properties: {
      內容摘要: { title: [{ text: { content: summary || "讀書紀錄" } }] },
      日期: { date: { start: date || new Date().toISOString().slice(0, 10) } },
      科目: subject ? { select: { name: subject } } : undefined,
      關聯單元: unitId ? { relation: [{ id: unitId }] } : undefined,
      讀書時數: hours != null ? { number: Number(hours) } : undefined,
    },
  });
  return page;
}

// 讀書紀錄
app.post("/api/study-log", async (req, res) => {
  try {
    const page = await createStudyLog(req.body);
    res.json({ id: page.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// AI 自動分類：讀取讀書摘要文字，比對現有科目/單元清單，挑出最符合的一個
app.post("/api/classify-study-log", async (req, res) => {
  try {
    if (!genAI) {
      return res.status(503).json({ error: "尚未設定 GEMINI_API_KEY，請先在 .env 加上再重啟伺服器" });
    }
    const { summary } = req.body;
    if (!summary || !summary.trim()) {
      return res.status(400).json({ error: "請先填寫內容摘要再自動分類" });
    }

    const result = await notion.databases.query({ database_id: DB.subjects });
    const list = result.results.map((p) => ({
      id: p.id,
      unit: titleOf(p, "單元"),
      subject: selectOf(p, "科目"),
    }));
    if (!list.length) {
      return res.status(400).json({ error: "目前還沒有任何單元，先去總覽新增單元" });
    }

    const numbered = list.map((s, i) => `${i + 1}. ${s.subject}/${s.unit}`).join("\n");
    const prompt = `以下是學生目前已建立的科目/單元清單：
${numbered}

學生剛剛寫了一段讀書內容摘要：
「${summary}」

請判斷這段摘要最符合清單中的哪一個編號，回覆一行「編號:N」（N 是清單裡的數字）。
如果清單裡沒有相符的單元，但你能從摘要判斷出屬於「國文」「數A」「自然」「英文」哪一科，
且能歸納出一個簡短明確的新單元名稱（例如「三角函數」「英文文法－關係子句」），
請回覆兩行，格式為：
新單元科目:X
新單元名稱:Y
如果連科目都判斷不出來，回覆「編號:0」。不要有其他文字，不要用 Markdown。`;

    const model = genAI.getGenerativeModel({ model: "gemini-flash-latest" });
    const result2 = await model.generateContent(prompt);
    const text = stripMarkdown(result2.response.text());

    const idxMatch = text.match(/編號[:：]\s*(\d+)/);
    const idx = idxMatch ? Number(idxMatch[1]) : 0;
    if (idx >= 1 && idx <= list.length) {
      const matched = list[idx - 1];
      return res.json({ matched: true, created: false, subject: matched.subject, unitId: matched.id, unit: matched.unit });
    }

    const subjectMatch = text.match(/新單元科目[:：]\s*(\S+)/);
    const nameMatch = text.match(/新單元名稱[:：]\s*(.+)/);
    if (subjectMatch && nameMatch) {
      const newSubject = subjectMatch[1].trim();
      const newUnitName = nameMatch[1].trim();
      // 保險：避免跟現有單元只差在措辭而重複建立，先做一次不分大小寫/去空白的比對
      const dup = list.find(
        (s) => s.subject === newSubject && s.unit.replace(/\s/g, "") === newUnitName.replace(/\s/g, "")
      );
      if (dup) {
        return res.json({ matched: true, created: false, subject: dup.subject, unitId: dup.id, unit: dup.unit });
      }
      const page = await notion.pages.create({
        parent: { database_id: DB.subjects },
        properties: {
          單元: { title: [{ text: { content: newUnitName } }] },
          科目: { select: { name: newSubject } },
          狀態: { select: { name: "未開始" } },
        },
      });
      return res.json({ matched: true, created: true, subject: newSubject, unitId: page.id, unit: newUnitName });
    }

    res.json({ matched: false });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 給 iOS 捷徑（Shortcuts）呼叫用的 webhook：計時器結束時自動記錄讀書時數
// Apple 內建「時鐘」App 沒有對外的自動化 API，所以用「捷徑」自建一個計時器
// （Wait 動作）取代，時間到就打這支 API 直接寫入 Notion。需要在 .env 設定 WEBHOOK_SECRET。
app.all("/api/webhook/study-log", async (req, res) => {
  try {
    if (!process.env.WEBHOOK_SECRET) {
      return res.status(503).json({ error: "尚未設定 WEBHOOK_SECRET，請先在 .env 加上再重啟伺服器" });
    }
    const params = { ...req.query, ...req.body };
    if (params.secret !== process.env.WEBHOOK_SECRET) {
      return res.status(401).json({ error: "secret 錯誤" });
    }
    const page = await createStudyLog({
      summary: params.summary || "捷徑計時器記錄",
      date: params.date,
      subject: params.subject,
      unitId: params.unitId,
      hours: params.hours,
    });
    res.json({ id: page.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 圖片上傳（拍照或選檔皆可）：跑 OCR 辨識，並把圖片直接上傳到 Notion 保存
app.post("/api/upload-image", upload.single("image"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "沒有收到圖片" });
  let text = "";
  try {
    const worker = await createWorker(["chi_tra", "eng"]);
    const { data } = await worker.recognize(req.file.buffer);
    text = (data.text || "").trim();
    await worker.terminate();
  } catch (e) {
    console.error("OCR failed:", e.message);
  }
  try {
    const fileUploadId = await uploadImageToNotion(
      req.file.buffer,
      req.file.originalname || "photo.jpg",
      req.file.mimetype || "image/jpeg"
    );
    res.json({ fileUploadId, text });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function fileProp(fileUploadId) {
  return fileUploadId ? { files: [{ type: "file_upload", file_upload: { id: fileUploadId } }] } : undefined;
}

function buildTestRecordProperties(body) {
  const {
    source, date, subject, unitId, total, correct, minutes, sourceType,
    imageFileUploadId, score,
    essay1ImageId, essay1Score,
    essay2ImageId, essay2Score,
    mathWorkImageId,
    englishEssayImageId, englishEssayScore,
    englishWritingImageId,
  } = body;
  return {
    來源: source != null ? { title: [{ text: { content: source } }] } : undefined,
    日期: date ? { date: { start: date } } : undefined,
    科目: subject ? { select: { name: subject } } : undefined,
    關聯單元: unitId ? { relation: [{ id: unitId }] } : undefined,
    總題數: total != null && total !== "" ? { number: Number(total) } : undefined,
    答對題數: correct != null && correct !== "" ? { number: Number(correct) } : undefined,
    作答時間: minutes != null && minutes !== "" ? { number: Number(minutes) } : undefined,
    來源類型: sourceType ? { select: { name: sourceType } } : undefined,
    分數: score != null && score !== "" ? { number: Number(score) } : undefined,
    圖片: fileProp(imageFileUploadId),
    作文一圖片: fileProp(essay1ImageId),
    作文一分數: essay1Score != null && essay1Score !== "" ? { number: Number(essay1Score) } : undefined,
    作文二圖片: fileProp(essay2ImageId),
    作文二分數: essay2Score != null && essay2Score !== "" ? { number: Number(essay2Score) } : undefined,
    手寫題圖片: fileProp(mathWorkImageId),
    英文作文圖片: fileProp(englishEssayImageId),
    英文作文分數: englishEssayScore != null && englishEssayScore !== "" ? { number: Number(englishEssayScore) } : undefined,
    英文手寫圖片: fileProp(englishWritingImageId),
  };
}

// 考卷/題本紀錄
app.post("/api/test-record", async (req, res) => {
  try {
    const page = await notion.pages.create({
      parent: { database_id: DB.testRecords },
      properties: buildTestRecordProperties(req.body),
    });
    res.json({ id: page.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 依科目篩選查詢考卷/題本紀錄
app.get("/api/test-records", async (req, res) => {
  try {
    const { subject } = req.query;
    const result = await notion.databases.query({
      database_id: DB.testRecords,
      filter: subject ? { property: "科目", select: { equals: subject } } : undefined,
      sorts: [{ timestamp: "created_time", direction: "descending" }],
      page_size: 100,
    });
    const items = result.results.map((p) => ({
      id: p.id,
      source: titleOf(p, "來源"),
      date: p.properties["日期"]?.date?.start || null,
      subject: selectOf(p, "科目"),
      sourceType: selectOf(p, "來源類型"),
      minutes: numberOf(p, "作答時間"),
      total: numberOf(p, "總題數"),
      correct: numberOf(p, "答對題數"),
      score: numberOf(p, "分數"),
      imageUrl: fileUrlOf(p, "圖片"),
      essay1: { imageUrl: fileUrlOf(p, "作文一圖片"), score: numberOf(p, "作文一分數"), feedback: p.properties["作文一回饋"]?.rich_text?.[0]?.plain_text || "" },
      essay2: { imageUrl: fileUrlOf(p, "作文二圖片"), score: numberOf(p, "作文二分數"), feedback: p.properties["作文二回饋"]?.rich_text?.[0]?.plain_text || "" },
      mathWork: { imageUrl: fileUrlOf(p, "手寫題圖片"), score: numberOf(p, "手寫題正確度"), feedback: p.properties["手寫題回饋"]?.rich_text?.[0]?.plain_text || "" },
      englishEssay: { imageUrl: fileUrlOf(p, "英文作文圖片"), score: numberOf(p, "英文作文分數"), feedback: p.properties["英文作文回饋"]?.rich_text?.[0]?.plain_text || "" },
      englishWriting: { imageUrl: fileUrlOf(p, "英文手寫圖片"), feedback: p.properties["英文手寫回饋"]?.rich_text?.[0]?.plain_text || "" },
    }));
    res.json(items);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 更新考卷/題本紀錄
app.patch("/api/test-records/:id", async (req, res) => {
  try {
    const properties = buildTestRecordProperties(req.body);
    Object.keys(properties).forEach((k) => properties[k] === undefined && delete properties[k]);
    const page = await notion.pages.update({ page_id: req.params.id, properties });
    res.json({ id: page.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// AI 批改：作文一/作文二/數A手寫過程/英文作文/英文手寫，用該筆紀錄裡對應的照片去跑 Gemini
app.post("/api/test-records/:id/grade", async (req, res) => {
  try {
    const { block } = req.body;
    const config = GRADE_BLOCKS[block];
    if (!config) return res.status(400).json({ error: "未知的批改區塊" });

    const page = await notion.pages.retrieve({ page_id: req.params.id });
    const fileData = await fetchNotionFileBuffer(page, config.image);
    if (!fileData) return res.status(400).json({ error: "這個區塊還沒有上傳圖片" });

    const feedback = await gradeImageWithGemini(fileData.buffer, fileData.mimeType, config.prompt);
    const score = config.score ? extractScore(feedback, config.scoreLabel) : null;

    const properties = { [config.feedback]: { rich_text: [{ text: { content: feedback } }] } };
    if (config.score && score != null) properties[config.score] = { number: score };
    await notion.pages.update({ page_id: req.params.id, properties });

    res.json({ feedback, score });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 錯題本
app.post("/api/wrong-question", async (req, res) => {
  try {
    const { question, subject, unitId, reason, explanation, imageFileUploadId } = req.body;
    const page = await notion.pages.create({
      parent: { database_id: DB.wrongQuestions },
      properties: {
        題目內容: { title: [{ text: { content: question } }] },
        科目: subject ? { select: { name: subject } } : undefined,
        關聯單元: unitId ? { relation: [{ id: unitId }] } : undefined,
        錯誤原因: reason ? { rich_text: [{ text: { content: reason } }] } : undefined,
        錯誤講解: explanation ? { rich_text: [{ text: { content: explanation } }] } : undefined,
        是否已複習: { checkbox: false },
        複習次數: { number: 0 },
        圖片: imageFileUploadId
          ? { files: [{ type: "file_upload", file_upload: { id: imageFileUploadId } }] }
          : undefined,
      },
    });
    res.json({ id: page.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/wrong-questions", async (req, res) => {
  try {
    const result = await notion.databases.query({
      database_id: DB.wrongQuestions,
      sorts: [{ timestamp: "created_time", direction: "descending" }],
      page_size: 50,
    });
    const items = result.results.map((p) => ({
      id: p.id,
      question: titleOf(p, "題目內容"),
      subject: selectOf(p, "科目"),
      reason: p.properties["錯誤原因"]?.rich_text?.[0]?.plain_text || "",
      explanation: p.properties["錯誤講解"]?.rich_text?.[0]?.plain_text || "",
      reviewed: p.properties["是否已複習"]?.checkbox || false,
      reviewCount: numberOf(p, "複習次數"),
      imageUrl: fileUrlOf(p, "圖片"),
    }));
    res.json(items);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 更新錯題（例如補上錯誤講解）
app.patch("/api/wrong-questions/:id", async (req, res) => {
  try {
    const { question, subject, reason, explanation } = req.body;
    const properties = {};
    if (question != null) properties["題目內容"] = { title: [{ text: { content: question } }] };
    if (subject != null) properties["科目"] = { select: { name: subject } };
    if (reason != null) properties["錯誤原因"] = { rich_text: [{ text: { content: reason } }] };
    if (explanation != null) properties["錯誤講解"] = { rich_text: [{ text: { content: explanation } }] };
    const page = await notion.pages.update({ page_id: req.params.id, properties });
    res.json({ id: page.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 複習模式：記錄一次複習（次數 +1，可標記已複習）
app.post("/api/wrong-questions/:id/review", async (req, res) => {
  try {
    const page = await notion.pages.retrieve({ page_id: req.params.id });
    const current = numberOf(page, "複習次數") || 0;
    const { mastered } = req.body;
    const page2 = await notion.pages.update({
      page_id: req.params.id,
      properties: {
        複習次數: { number: current + 1 },
        是否已複習: { checkbox: !!mastered },
      },
    });
    res.json({ id: page2.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// AI 解析：彙整科目進度、錯題、考卷資料，請 Gemini 分析弱點並給複習建議
app.post("/api/ai-analyze", async (req, res) => {
  try {
    if (!process.env.GEMINI_API_KEY) {
      return res.status(503).json({ error: "尚未設定 GEMINI_API_KEY，請先在 .env 加上再重啟伺服器" });
    }
    const [subjectsRes, wrongRes, testRes] = await Promise.all([
      notion.databases.query({ database_id: DB.subjects }),
      notion.databases.query({ database_id: DB.wrongQuestions, page_size: 100 }),
      notion.databases.query({ database_id: DB.testRecords, page_size: 100 }),
    ]);

    const subjectsSummary = subjectsRes.results
      .map((p) => `${selectOf(p, "科目")}/${titleOf(p, "單元")}：狀態=${selectOf(p, "狀態") || "未設定"}，熟悉度=${numberOf(p, "熟悉度") ?? "未評分"}`)
      .join("\n");

    const wrongSummary = wrongRes.results
      .map((p) => {
        const q = titleOf(p, "題目內容");
        const subject = selectOf(p, "科目");
        const reason = p.properties["錯誤原因"]?.rich_text?.[0]?.plain_text || "";
        const reviewed = p.properties["是否已複習"]?.checkbox ? "已複習" : "未複習";
        return `[${subject || "未分類"}] ${q}｜原因：${reason || "無"}｜${reviewed}`;
      })
      .join("\n");

    const testSummary = testRes.results
      .map((p) => {
        const subject = selectOf(p, "科目");
        const total = numberOf(p, "總題數");
        const correct = numberOf(p, "答對題數");
        const acc = total ? Math.round((correct / total) * 100) : null;
        return `${titleOf(p, "來源")}｜${subject || ""}｜${correct}/${total}（${acc ?? "-"}%）`;
      })
      .join("\n");

    const prompt = `你是一個學測複習教練，請用繁體中文分析以下學生的複習資料，並給出：
1. 各科弱點趨勢摘要（哪個科目/單元最弱、正確率最低）
2. 錯題中反覆出現的知識點或錯誤模式
3. 具體且優先排序的下一步複習計畫（列出 3-5 個建議，越急迫的排越前面）

請條理清楚、精簡，不要有多餘的客套話。用純文字回覆，不要使用任何 Markdown 語法
（不要用 **、#、-、\`\`\` 這類符號），標題和項目用文字本身與換行、數字編號來呈現即可。

【科目進度】
${subjectsSummary || "（無資料）"}

【錯題本】
${wrongSummary || "（無資料）"}

【考卷/題本紀錄】
${testSummary || "（無資料）"}`;

    const model = genAI.getGenerativeModel({ model: "gemini-flash-latest" });
    const result = await model.generateContent(prompt);
    res.json({ analysis: stripMarkdown(result.response.text()) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 模擬考成績
app.post("/api/mock-exams", async (req, res) => {
  try {
    const { name, date, chinese, mathA, science, english, notes } = req.body;
    const page = await notion.pages.create({
      parent: { database_id: DB.mockExams },
      properties: {
        名稱: { title: [{ text: { content: name } }] },
        日期: { date: { start: date } },
        國文級分: chinese != null && chinese !== "" ? { number: Number(chinese) } : undefined,
        數A級分: mathA != null && mathA !== "" ? { number: Number(mathA) } : undefined,
        自然級分: science != null && science !== "" ? { number: Number(science) } : undefined,
        英文級分: english != null && english !== "" ? { number: Number(english) } : undefined,
        備註: notes ? { rich_text: [{ text: { content: notes } }] } : undefined,
      },
    });
    res.json({ id: page.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/mock-exams", async (req, res) => {
  try {
    const result = await notion.databases.query({
      database_id: DB.mockExams,
      sorts: [{ property: "日期", direction: "ascending" }],
      page_size: 100,
    });
    const items = result.results.map((p) => ({
      id: p.id,
      name: titleOf(p, "名稱"),
      date: p.properties["日期"]?.date?.start || null,
      chinese: numberOf(p, "國文級分"),
      mathA: numberOf(p, "數A級分"),
      science: numberOf(p, "自然級分"),
      english: numberOf(p, "英文級分"),
      total: p.properties["總級分"]?.formula?.number ?? null,
      notes: p.properties["備註"]?.rich_text?.[0]?.plain_text || "",
    }));
    res.json(items);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, "0.0.0.0", () => {
  console.log(`學測複習追蹤已啟動: http://localhost:${port}`);
});
