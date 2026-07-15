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
};

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

const app = express();
app.use(express.json());
app.use(express.static("public"));

function titleOf(page, prop) {
  return page.properties[prop]?.title?.[0]?.plain_text || "";
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

// 考卷/題本紀錄
app.post("/api/test-record", async (req, res) => {
  try {
    const { source, date, subject, unitId, total, correct, imageFileUploadId } = req.body;
    const page = await notion.pages.create({
      parent: { database_id: DB.testRecords },
      properties: {
        來源: { title: [{ text: { content: source } }] },
        日期: { date: { start: date } },
        科目: subject ? { select: { name: subject } } : undefined,
        關聯單元: unitId ? { relation: [{ id: unitId }] } : undefined,
        總題數: total != null ? { number: Number(total) } : undefined,
        答對題數: correct != null ? { number: Number(correct) } : undefined,
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

請條理清楚、精簡，用小標題整理，不要有多餘的客套話。

【科目進度】
${subjectsSummary || "（無資料）"}

【錯題本】
${wrongSummary || "（無資料）"}

【考卷/題本紀錄】
${testSummary || "（無資料）"}`;

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-flash-latest" });
    const result = await model.generateContent(prompt);
    res.json({ analysis: result.response.text() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, "0.0.0.0", () => {
  console.log(`學測複習追蹤已啟動: http://localhost:${port}`);
});
