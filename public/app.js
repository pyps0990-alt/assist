// ---- 讓底部工具列/AI 按鈕真正「永遠浮在最下方」 ----
// 手機瀏覽器（尤其 iOS Safari）在鍵盤彈出、網址列收合/展開時，position:fixed
// 元素會用「layout viewport」而非「visual viewport」計算位置，導致工具列
// 看起來沒有固定在最下面、或被鍵盤蓋住。用 visualViewport API 即時算出
// 目前畫面實際可見範圍的下緣，動態調整這些元素的 bottom，確保任何時候
// （載入中、鍵盤開啟、網址列變化）都貼齊真正看得到的螢幕底部。
(function pinToVisibleBottom() {
  const targets = () => [
    document.querySelector(".glass-nav"),
    document.getElementById("aiFab"),
  ].filter(Boolean);

  function reposition() {
    const vv = window.visualViewport;
    const hiddenBelow = vv ? Math.max(window.innerHeight - (vv.height + vv.offsetTop), 0) : 0;
    targets().forEach((el) => {
      el.style.setProperty("--viewport-offset", `${hiddenBelow}px`);
    });
  }

  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", reposition);
    window.visualViewport.addEventListener("scroll", reposition);
  }
  window.addEventListener("orientationchange", reposition);
  document.addEventListener("DOMContentLoaded", reposition);
  reposition();
})();

const tabBtns = document.querySelectorAll(".tab-btn");
const panels = document.querySelectorAll(".tab-panel");
const navIndicator = document.getElementById("navIndicator");
const tabOrder = Array.from(tabBtns).map((b) => b.dataset.tab);

function moveNavIndicator(btn) {
  if (!navIndicator) return;
  navIndicator.style.left = `${btn.offsetLeft}px`;
  navIndicator.style.width = `${btn.offsetWidth}px`;
}

function activateTab(tabName) {
  const btn = Array.from(tabBtns).find((b) => b.dataset.tab === tabName);
  if (!btn || btn.classList.contains("active")) return;
  tabBtns.forEach((b) => b.classList.remove("active"));
  panels.forEach((p) => p.classList.remove("active"));
  btn.classList.add("active");
  document.getElementById(tabName).classList.add("active");
  moveNavIndicator(btn);
  if (tabName === "dashboard") loadDashboard();
  if (tabName === "wrong") loadWrongList();
  if (tabName === "mockExam") loadMockExams();
}

tabBtns.forEach((btn) => {
  btn.addEventListener("click", () => activateTab(btn.dataset.tab));
});

window.addEventListener("load", () => moveNavIndicator(document.querySelector(".tab-btn.active")));
window.addEventListener("resize", () => moveNavIndicator(document.querySelector(".tab-btn.active")));

// ---- 左右滑動切換分頁 ----
(function initSwipe() {
  const main = document.querySelector("main");
  let startX = 0;
  let startY = 0;
  let swiping = false;

  main.addEventListener(
    "touchstart",
    (e) => {
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      swiping = true;
    },
    { passive: true }
  );

  main.addEventListener(
    "touchend",
    (e) => {
      if (!swiping) return;
      swiping = false;
      const dx = e.changedTouches[0].clientX - startX;
      const dy = e.changedTouches[0].clientY - startY;
      if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      const activeTab = document.querySelector(".tab-btn.active").dataset.tab;
      const idx = tabOrder.indexOf(activeTab);
      const nextIdx = dx < 0 ? idx + 1 : idx - 1;
      if (nextIdx >= 0 && nextIdx < tabOrder.length) activateTab(tabOrder[nextIdx]);
    },
    { passive: true }
  );
})();

function esc(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

// 依科目分組（用 <optgroup>），選單先看到科目再看到底下的單元，不再是一長串混雜清單
async function loadUnits() {
  const res = await fetch("/api/subjects");
  const subjects = await res.json();
  const selects = ["studyUnitSelect", "testUnitSelect", "wrongUnitSelect"];
  selects.forEach((id) => {
    const sel = document.getElementById(id);
    const current = sel.value;
    sel.innerHTML = '<option value="">(不指定)</option>';
    SUBJECT_ORDER.forEach((subject) => {
      const units = subjects.filter((s) => s.subject === subject);
      if (!units.length) return;
      const group = document.createElement("optgroup");
      group.label = subject;
      units.forEach((s) => {
        const opt = document.createElement("option");
        opt.value = s.id;
        opt.textContent = s.unit;
        group.appendChild(opt);
      });
      sel.appendChild(group);
    });
    subjects
      .filter((s) => !SUBJECT_ORDER.includes(s.subject))
      .forEach((s) => {
        const opt = document.createElement("option");
        opt.value = s.id;
        opt.textContent = `${s.subject || "未分類"} - ${s.unit}`;
        sel.appendChild(opt);
      });
    sel.value = current;
  });
  return subjects;
}

function pct(n) {
  return n == null ? "—" : `${Math.round(n * 100)}%`;
}

function subjectStyle(subject) {
  return subject ? `style="color:var(--subject-${esc(subject)})"` : "";
}

const SUBJECT_OPTIONS = ["國文", "數A", "自然", "英文"];
const STATUS_OPTIONS = ["未開始", "進行中", "已完成", "需複習"];

function skeletonCards(n = 3) {
  return Array.from({ length: n }, () => '<div class="skeleton-card"></div>').join("");
}

const SUBJECT_ORDER = ["國文", "數A", "自然", "英文"];
const STATUS_PRIORITY = { 需複習: 0, 進行中: 1, 未開始: 2, 已完成: 3 };

// 自動熟悉度：正確率(50%) + 錯題複習完成率(30%) + 讀書時數達成度(20%，以5小時為滿分)
// 換算成 1-5 分。三項數據都沒有時，回退顯示手動輸入的熟悉度，都沒有就顯示「未評分」
function autoMastery(s) {
  const parts = [];
  if (s.accuracy != null) parts.push({ v: s.accuracy, w: 0.5 });
  if (s.reviewRate != null) parts.push({ v: s.reviewRate, w: 0.3 });
  if (s.studyHours != null && s.studyHours > 0) parts.push({ v: Math.min(s.studyHours / 5, 1), w: 0.2 });
  if (!parts.length) return null;
  const totalWeight = parts.reduce((a, p) => a + p.w, 0);
  const score = parts.reduce((a, p) => a + p.v * p.w, 0) / totalWeight;
  return Math.round(score * 5 * 10) / 10;
}

// 自動排序：先依科目固定順序分組，組內把「需複習/進行中」排前面，
// 自動熟悉度（沒有就用手動熟悉度）低的（較弱的單元）優先，方便一打開就看到最需要複習的內容
function sortSubjects(subjects) {
  return [...subjects].sort((a, b) => {
    const subjectDiff = SUBJECT_ORDER.indexOf(a.subject) - SUBJECT_ORDER.indexOf(b.subject);
    if (subjectDiff !== 0) return subjectDiff;
    const statusDiff = (STATUS_PRIORITY[a.status] ?? 9) - (STATUS_PRIORITY[b.status] ?? 9);
    if (statusDiff !== 0) return statusDiff;
    const aMastery = autoMastery(a) ?? a.mastery ?? 99;
    const bMastery = autoMastery(b) ?? b.mastery ?? 99;
    if (aMastery !== bMastery) return aMastery - bMastery;
    return a.unit.localeCompare(b.unit, "zh-Hant");
  });
}

let dashboardCache = null;

// 先顯示上次的資料（如果有），背景悄悄重新整理，避免每次切分頁都閃一次骨架屏
async function loadDashboard() {
  const list = document.getElementById("subjectList");
  if (dashboardCache) renderSubjectList(list, dashboardCache);
  else list.innerHTML = skeletonCards();
  try {
    const res = await fetch("/api/subjects");
    const subjects = sortSubjects(await res.json());
    dashboardCache = subjects;
    renderSubjectList(list, subjects);
  } catch (e) {
    if (!dashboardCache) list.innerHTML = `<p class="loading">載入失敗：${esc(e.message)}</p>`;
  }
}

function renderSubjectList(list, subjects) {
  if (!subjects.length) {
    list.innerHTML = '<p class="loading">尚無資料，先在上方新增單元</p>';
    return;
  }
  list.innerHTML = subjects.map(renderCard).join("");
  list.querySelectorAll("[data-edit]").forEach((btn) =>
    btn.addEventListener("click", () => toggleEdit(btn.dataset.edit))
  );
  list.querySelectorAll("[data-save]").forEach((btn) =>
    btn.addEventListener("click", () => saveUnit(btn.dataset.save))
  );
  list.querySelectorAll("[data-delete]").forEach((btn) =>
    btn.addEventListener("click", () => deleteUnit(btn.dataset.delete))
  );
}

function renderCard(s) {
  return `
  <div class="card" id="card-${s.id}">
    <div class="view">
      <div class="row">
        <span class="title">${esc(s.unit)}</span>
        <span class="status-badge">${esc(s.status || "未設定")}</span>
      </div>
      <div class="subject" ${subjectStyle(s.subject)}>${esc(s.subject || "")}</div>
      <div class="stats">
        <span>正確率 <b>${pct(s.accuracy)}</b></span>
        <span>讀書時數 <b>${s.studyHours ?? 0}</b></span>
        <span>熟悉度(自動) <b>${autoMastery(s) ?? "—"}</b></span>
        <span>熟悉度(手動) <b>${s.mastery ?? "—"}</b></span>
      </div>
      <div class="card-actions">
        <button class="link-btn" data-edit="${s.id}">${icon("edit")}編輯</button>
        <button class="link-btn danger" data-delete="${s.id}">${icon("trash")}刪除</button>
      </div>
    </div>
    <div class="edit-form" style="display:none">
      <label>單元名稱<input type="text" value="${esc(s.unit)}" data-field="unit"></label>
      <label>科目
        <select data-field="subject">
          ${SUBJECT_OPTIONS.map((o) => `<option ${o === s.subject ? "selected" : ""}>${o}</option>`).join("")}
        </select>
      </label>
      <label>狀態
        <select data-field="status">
          ${STATUS_OPTIONS.map((o) => `<option ${o === s.status ? "selected" : ""}>${o}</option>`).join("")}
        </select>
      </label>
      <label>熟悉度 (1-5)<input type="number" min="1" max="5" value="${s.mastery ?? ""}" data-field="mastery"></label>
      <div class="card-actions">
        <button class="link-btn" data-save="${s.id}">${icon("check")}儲存</button>
        <button class="link-btn" data-edit="${s.id}">${icon("cross")}取消</button>
      </div>
    </div>
  </div>`;
}

function toggleEdit(id) {
  const card = document.getElementById(`card-${id}`);
  const view = card.querySelector(".view");
  const form = card.querySelector(".edit-form");
  const showingEdit = form.style.display === "none";
  view.style.display = showingEdit ? "none" : "";
  form.style.display = showingEdit ? "" : "none";
}

async function saveUnit(id) {
  const card = document.getElementById(`card-${id}`);
  const fields = card.querySelectorAll("[data-field]");
  const body = {};
  fields.forEach((f) => (body[f.dataset.field] = f.value));
  try {
    const res = await fetch(`/api/subjects/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || "更新失敗");
    loadDashboard();
    loadUnits();
  } catch (e) {
    alert(e.message);
  }
}

async function deleteUnit(id) {
  if (!confirm("確定要刪除這個單元嗎？（會從 Notion 移到垃圾桶）")) return;
  try {
    const res = await fetch(`/api/subjects/${id}`, { method: "DELETE" });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || "刪除失敗");
    loadDashboard();
    loadUnits();
  } catch (e) {
    alert(e.message);
  }
}

let wrongItemsCache = [];
let wrongListLoaded = false;

function renderWrongList(list, items) {
  if (!items.length) {
    list.innerHTML = '<p class="loading">尚無錯題紀錄</p>';
    return;
  }
  list.innerHTML = items
    .map(
      (q) => `
    <div class="card">
      <div class="row">
        <span class="title">${esc(q.question)}</span>
        <span class="status-badge ${q.reviewed ? '' : 'pulse'}" ${q.reviewed ? '' : 'style="background:var(--amber-soft);color:var(--amber)"'}>${q.reviewed ? "已複習" : "未複習"}</span>
      </div>
      <div class="subject" ${subjectStyle(q.subject)}>${esc(q.subject || "")}</div>
      ${q.imageUrl ? `<img src="${esc(q.imageUrl)}" class="img-preview">` : ""}
      ${q.explanation ? `<div class="explanation-box">${icon("lightbulb")}${esc(q.explanation)}</div>` : ""}
    </div>`
    )
    .join("");
}

// 先顯示上次的資料（如果有），背景悄悄重新整理，避免每次切分頁都閃一次骨架屏
async function loadWrongList() {
  const list = document.getElementById("wrongList");
  if (wrongListLoaded) renderWrongList(list, wrongItemsCache);
  else list.innerHTML = skeletonCards(2);
  try {
    const res = await fetch("/api/wrong-questions");
    wrongItemsCache = await res.json();
    wrongListLoaded = true;
    renderWrongList(list, wrongItemsCache);
  } catch (e) {
    if (!wrongListLoaded) list.innerHTML = `<p class="loading">載入失敗：${esc(e.message)}</p>`;
  }
}

// ---- 圖片拍照/上傳 + OCR 辨識 ----
function bindImageUpload(inputIds, msgId, previewId, urlFieldId, onRecognized) {
  const msg = document.getElementById(msgId);
  const preview = document.getElementById(previewId);
  const urlField = document.getElementById(urlFieldId);

  async function handleFile(file) {
    if (!file) return;
    preview.src = URL.createObjectURL(file);
    preview.style.display = "block";
    msg.textContent = "上傳並辨識中...";
    msg.classList.remove("error");
    try {
      const fd = new FormData();
      fd.append("image", file);
      const res = await fetch("/api/upload-image", { method: "POST", body: fd });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "上傳失敗");
      urlField.value = json.fileUploadId;
      msg.textContent = json.text ? "辨識完成，已自動帶入文字（可修改）" : "上傳完成（未辨識到文字）";
      if (onRecognized) onRecognized(json.text);
    } catch (e) {
      msg.textContent = e.message;
      msg.classList.add("error");
    }
  }

  inputIds.forEach((id) => {
    const input = document.getElementById(id);
    input.addEventListener("change", () => handleFile(input.files[0]));
  });
}

bindImageUpload(
  ["wrongImageInputCamera", "wrongImageInputGallery"],
  "wrongOcrMsg",
  "wrongImagePreview",
  "wrongImageFileUploadId",
  (text) => {
    const q = document.querySelector('#wrongForm textarea[name="question"]');
    if (text && !q.value) q.value = text;
  }
);

bindImageUpload(
  ["testImageInputCamera", "testImageInputGallery"],
  "testOcrMsg",
  "testImagePreview",
  "testImageFileUploadId"
);

function resetImagePreview(previewId, urlFieldId, msgId) {
  document.getElementById(previewId).style.display = "none";
  document.getElementById(urlFieldId).value = "";
  document.getElementById(msgId).textContent = "";
}

// ---- 讀書計時器 ----
// 用真實時間戳計算經過秒數（而非累加 tick 次數），這樣即使瀏覽器把分頁背景化、
// setInterval 被節流，回到前景時顯示的時間依然正確。狀態存在 localStorage，
// 就算頁面被系統整個關掉重開也能恢復進度。
(function initTimer() {
  const STORAGE_KEY = "studyTimerState";
  const display = document.getElementById("timerDisplay");
  const startBtn = document.getElementById("timerStart");
  const pauseBtn = document.getElementById("timerPause");
  const resetBtn = document.getElementById("timerReset");
  const hoursInput = document.getElementById("studyHoursInput");

  let ticking = null;
  let wakeLock = null;
  let state = loadState();

  function loadState() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (saved && typeof saved.accumulated === "number") return saved;
    } catch (e) {}
    return { running: false, startedAt: null, accumulated: 0 };
  }

  function saveState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function currentSeconds() {
    const live = state.running ? (Date.now() - state.startedAt) / 1000 : 0;
    return state.accumulated + live;
  }

  function render() {
    const total = Math.floor(currentSeconds());
    const h = String(Math.floor(total / 3600)).padStart(2, "0");
    const m = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
    const s = String(total % 60).padStart(2, "0");
    display.textContent = `${h}:${m}:${s}`;
    hoursInput.value = (currentSeconds() / 3600).toFixed(2);
  }

  function setButtons() {
    startBtn.disabled = state.running;
    pauseBtn.disabled = !state.running;
    resetBtn.disabled = !state.running && state.accumulated === 0;
  }

  async function requestWakeLock() {
    try {
      if ("wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen");
    } catch (e) {
      // 不支援或被拒絕時忽略，計時仍會用時間戳正確運作，只是螢幕可能自動熄滅
    }
  }

  function releaseWakeLock() {
    if (wakeLock) {
      wakeLock.release().catch(() => {});
      wakeLock = null;
    }
  }

  function startTicking() {
    clearInterval(ticking);
    ticking = setInterval(render, 1000);
  }

  startBtn.addEventListener("click", () => {
    state.running = true;
    state.startedAt = Date.now();
    saveState();
    setButtons();
    startTicking();
    requestWakeLock();
    render();
  });

  pauseBtn.addEventListener("click", () => {
    state.accumulated = currentSeconds();
    state.running = false;
    state.startedAt = null;
    saveState();
    clearInterval(ticking);
    releaseWakeLock();
    setButtons();
    render();
  });

  function resetTimer() {
    state = { running: false, startedAt: null, accumulated: 0 };
    saveState();
    clearInterval(ticking);
    releaseWakeLock();
    hoursInput.value = "";
    display.textContent = "00:00:00";
    setButtons();
  }

  resetBtn.addEventListener("click", resetTimer);
  window.resetStudyTimer = resetTimer;

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      render();
      if (state.running) {
        startTicking();
        requestWakeLock();
      }
    }
  });

  // 初始化：還原上次的計時狀態
  render();
  setButtons();
  if (state.running) {
    startTicking();
    requestWakeLock();
  }
})();

// ---- 錯題複習模式（flashcard）----
(function initReview() {
  const startReviewBtn = document.getElementById("startReview");
  const box = document.getElementById("reviewBox");
  const imgEl = document.getElementById("reviewImage");
  const qEl = document.getElementById("reviewQuestion");
  const reasonEl = document.getElementById("reviewReason");
  const progressEl = document.getElementById("reviewProgress");
  const masteredBtn = document.getElementById("reviewMastered");
  const againBtn = document.getElementById("reviewAgain");
  const revealBtn = document.getElementById("revealExplanation");
  const explanationEl = document.getElementById("reviewExplanation");

  let queue = [];
  let idx = 0;

  function showCurrent() {
    if (idx >= queue.length) {
      box.style.display = "none";
      progressEl.textContent = "";
      return;
    }
    const q = queue[idx];
    qEl.textContent = q.question;
    reasonEl.textContent = q.reason ? `原因：${q.reason}` : "";
    if (q.imageUrl) {
      imgEl.src = q.imageUrl;
      imgEl.style.display = "block";
    } else {
      imgEl.style.display = "none";
    }
    explanationEl.style.display = "none";
    explanationEl.textContent = "";
    revealBtn.style.display = q.explanation ? "inline-flex" : "none";
    progressEl.textContent = `第 ${idx + 1} / ${queue.length} 題`;
    box.style.display = "block";
  }

  revealBtn.addEventListener("click", () => {
    const q = queue[idx];
    explanationEl.textContent = q.explanation;
    explanationEl.style.display = "block";
    revealBtn.style.display = "none";
  });

  async function mark(mastered) {
    const q = queue[idx];
    try {
      await fetch(`/api/wrong-questions/${q.id}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mastered }),
      });
    } catch (e) {
      console.error(e);
    }
    idx += 1;
    showCurrent();
  }

  masteredBtn.addEventListener("click", () => mark(true));
  againBtn.addEventListener("click", () => mark(false));

  startReviewBtn.addEventListener("click", async () => {
    await loadWrongList();
    queue = wrongItemsCache.filter((q) => !q.reviewed);
    if (!queue.length) queue = wrongItemsCache.slice();
    idx = 0;
    if (!queue.length) {
      alert("目前沒有錯題可以複習");
      return;
    }
    showCurrent();
  });
})();

function bindForm(formId, msgId, url, buildBody, onDone) {
  const form = document.getElementById(formId);
  const msg = document.getElementById(msgId);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    msg.textContent = "送出中...";
    msg.classList.remove("error");
    const data = Object.fromEntries(new FormData(form).entries());
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildBody(data)),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "送出失敗");
      msg.textContent = "已同步到 Notion";
      form.reset();
      if (onDone) onDone();
    } catch (err) {
      msg.textContent = err.message;
      msg.classList.add("error");
    }
  });
}

bindForm(
  "addUnitForm",
  "addUnitMsg",
  "/api/subjects",
  (d) => ({ unit: d.unit, subject: d.subject }),
  () => {
    loadDashboard();
    loadUnits();
  }
);

bindForm(
  "studyForm",
  "studyMsg",
  "/api/study-log",
  (d) => ({
    date: d.date,
    subject: d.subject,
    unitId: d.unitId || undefined,
    hours: d.hours,
    summary: d.summary,
  }),
  () => window.resetStudyTimer && window.resetStudyTimer()
);

// ---- AI 自動分類讀書紀錄的科目/單元 ----
(function initClassifyStudyLog() {
  const btn = document.getElementById("classifyStudyBtn");
  const msg = document.getElementById("classifyMsg");
  const summaryInput = document.getElementById("studySummaryInput");
  const subjectSelect = document.getElementById("studySubjectSelect");
  const unitSelect = document.getElementById("studyUnitSelect");

  btn.addEventListener("click", async () => {
    const summary = summaryInput.value.trim();
    if (!summary) {
      msg.textContent = "先填寫內容摘要再自動分類";
      msg.classList.add("error");
      return;
    }
    btn.disabled = true;
    msg.textContent = "AI 判斷中...";
    msg.classList.remove("error");
    try {
      const res = await fetch("/api/classify-study-log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ summary }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "分類失敗");
      if (!json.matched) {
        msg.textContent = "AI 連科目都判斷不出來，請手動選擇";
        msg.classList.add("error");
        return;
      }
      if (json.created) {
        await loadUnits();
        dashboardCache = null;
      }
      subjectSelect.value = json.subject;
      unitSelect.value = json.unitId;
      msg.textContent = json.created
        ? `AI 判斷這是新單元，已自動建立「${json.subject}／${json.unit}」並選好`
        : `已自動選為 ${json.subject}／${json.unit}`;
    } catch (e) {
      msg.textContent = e.message;
      msg.classList.add("error");
    } finally {
      btn.disabled = false;
    }
  });
})();

bindForm(
  "testForm",
  "testMsg",
  "/api/test-record",
  (d) => ({
    date: d.date,
    subject: d.subject,
    sourceType: d.sourceType,
    source: d.source,
    unitId: d.unitId || undefined,
    minutes: d.minutes || undefined,
    total: d.total || undefined,
    correct: d.correct || undefined,
    score: d.score || undefined,
    imageFileUploadId: d.imageFileUploadId || undefined,
    essay1ImageId: d.essay1ImageId || undefined,
    essay2ImageId: d.essay2ImageId || undefined,
    mathWorkImageId: d.mathWorkImageId || undefined,
    englishEssayImageId: d.englishEssayImageId || undefined,
    englishWritingImageId: d.englishWritingImageId || undefined,
  }),
  () => {
    resetImagePreview("testImagePreview", "testImageFileUploadId", "testOcrMsg");
    ["essay1", "essay2", "mathWork", "englishEssay", "englishWriting"].forEach((prefix) =>
      resetImagePreview(`${prefix}Preview`, `${prefix}ImageId`, "testMsg")
    );
    loadTestList();
  }
);

// ---- 考卷分頁：科目 chip 選擇、動態欄位顯示 ----
let currentTestSubject = null;

function applySubjectVisibility(subject) {
  document.querySelectorAll("#testForm .subject-only").forEach((block) => {
    const subjects = block.dataset.subjects.split(",");
    const show = subjects.includes(subject);
    block.style.display = show ? "" : "none";
    block.querySelectorAll("input, select, textarea").forEach((f) => (f.disabled = !show));
  });
}

document.querySelectorAll("#testSubjectChips .subject-chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    currentTestSubject = chip.dataset.subject;
    document.querySelectorAll("#testSubjectChips .subject-chip").forEach((c) => c.classList.remove("active"));
    chip.classList.add("active");
    document.getElementById("testSubjectField").value = currentTestSubject;
    document.getElementById("testForm").style.display = "flex";
    document.getElementById("testEmptyHint").style.display = "none";
    document.getElementById("testListTitle").style.display = "block";
    applySubjectVisibility(currentTestSubject);
    loadTestList();
  });
});

const GRADE_BLOCK_LABELS = {
  essay1: "AI 批改作文一",
  essay2: "AI 批改作文二",
  mathWork: "AI 判讀手寫過程",
  englishEssay: "AI 批改作文",
  englishWriting: "AI 批改手寫作答",
};

function renderGradeBlock(recordId, key, block, title) {
  if (!block.imageUrl) return "";
  const scoreLine = block.score != null ? `<div class="grade-score">分數：${block.score}</div>` : "";
  return `
    <div class="grade-block">
      <div class="test-block-title">${esc(title)}</div>
      <img src="${esc(block.imageUrl)}" class="img-preview">
      <button type="button" class="grade-btn" data-grade-record="${recordId}" data-grade-block="${key}">
        ${icon("lightbulb")}${GRADE_BLOCK_LABELS[key]}
      </button>
      <div class="grade-result" data-grade-result="${recordId}-${key}">
        ${scoreLine}
        ${block.feedback ? `<div class="explanation-box">${esc(block.feedback)}</div>` : ""}
      </div>
    </div>`;
}

function renderTestCard(r) {
  const answerStats =
    r.total != null
      ? `<span>答對 <b>${r.correct ?? 0}/${r.total}</b>（答錯 ${r.total - (r.correct ?? 0)}）</span>`
      : "";
  return `
  <div class="card">
    <div class="row">
      <span class="title">${esc(r.source)}</span>
      <span class="status-badge">${esc(r.sourceType || "")}</span>
    </div>
    <div class="subject" ${subjectStyle(r.subject)}>${esc(r.subject || "")} ・ ${esc(r.date || "")}</div>
    <div class="stats">
      ${answerStats}
      ${r.score != null ? `<span>分數 <b>${r.score}</b></span>` : ""}
      ${r.minutes != null ? `<span>作答時間 <b>${r.minutes} 分</b></span>` : ""}
    </div>
    ${r.imageUrl ? `<img src="${esc(r.imageUrl)}" class="img-preview">` : ""}
    ${renderGradeBlock(r.id, "essay1", r.essay1, "作文一")}
    ${renderGradeBlock(r.id, "essay2", r.essay2, "作文二")}
    ${renderGradeBlock(r.id, "mathWork", r.mathWork, "手寫過程")}
    ${renderGradeBlock(r.id, "englishEssay", r.englishEssay, "英文作文")}
    ${renderGradeBlock(r.id, "englishWriting", r.englishWriting, "英文手寫作答")}
  </div>`;
}

let testListCache = {};

async function loadTestList() {
  if (!currentTestSubject) return;
  const list = document.getElementById("testList");
  const cached = testListCache[currentTestSubject];
  if (cached) renderTestList(list, cached);
  else list.innerHTML = skeletonCards(2);
  try {
    const res = await fetch(`/api/test-records?subject=${encodeURIComponent(currentTestSubject)}`);
    const items = await res.json();
    testListCache[currentTestSubject] = items;
    renderTestList(list, items);
  } catch (e) {
    if (!cached) list.innerHTML = `<p class="loading">載入失敗：${esc(e.message)}</p>`;
  }
}

function renderTestList(list, items) {
  if (!items.length) {
    list.innerHTML = '<p class="loading">這個科目還沒有紀錄</p>';
    return;
  }
  list.innerHTML = items.map(renderTestCard).join("");
  list.querySelectorAll("[data-grade-record]").forEach((btn) => {
    btn.addEventListener("click", () => runGrade(btn.dataset.gradeRecord, btn.dataset.gradeBlock, btn));
  });
}

async function runGrade(recordId, block, btn) {
  btn.disabled = true;
  const originalHtml = btn.innerHTML;
  btn.innerHTML = "批改中...";
  try {
    const res = await fetch(`/api/test-records/${recordId}/grade`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ block }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || "批改失敗");
    const resultEl = document.querySelector(`[data-grade-result="${recordId}-${block}"]`);
    resultEl.innerHTML = `
      ${json.score != null ? `<div class="grade-score">分數：${json.score}</div>` : ""}
      <div class="explanation-box">${esc(json.feedback)}</div>`;
    btn.style.display = "none";
  } catch (e) {
    alert(e.message);
    btn.disabled = false;
    btn.innerHTML = originalHtml;
  }
}

bindImageUpload(["essay1InputCamera", "essay1InputGallery"], "testMsg", "essay1Preview", "essay1ImageId");
bindImageUpload(["essay2InputCamera", "essay2InputGallery"], "testMsg", "essay2Preview", "essay2ImageId");
bindImageUpload(["mathWorkInputCamera", "mathWorkInputGallery"], "testMsg", "mathWorkPreview", "mathWorkImageId");
bindImageUpload(["englishEssayInputCamera", "englishEssayInputGallery"], "testMsg", "englishEssayPreview", "englishEssayImageId");
bindImageUpload(["englishWritingInputCamera", "englishWritingInputGallery"], "testMsg", "englishWritingPreview", "englishWritingImageId");

bindForm(
  "wrongForm",
  "wrongMsg",
  "/api/wrong-question",
  (d) => ({
    subject: d.subject,
    unitId: d.unitId || undefined,
    question: d.question,
    reason: d.reason,
    explanation: d.explanation,
    imageFileUploadId: d.imageFileUploadId || undefined,
  }),
  () => {
    loadWrongList();
    resetImagePreview("wrongImagePreview", "wrongImageFileUploadId", "wrongOcrMsg");
  }
);

// ---- AI 解析 ----
(function initAiAnalyze() {
  const fab = document.getElementById("aiFab");
  const scrim = document.getElementById("aiScrim");
  const popover = document.getElementById("aiPopover");
  const closeBtn = document.getElementById("aiPopoverClose");
  const btn = document.getElementById("aiAnalyzeBtn");
  const msg = document.getElementById("aiAnalyzeMsg");
  const result = document.getElementById("aiAnalyzeResult");
  const loading = document.getElementById("aiLoading");

  function openPopover() {
    popover.style.display = "block";
    scrim.style.display = "block";
  }
  function closePopover() {
    popover.style.display = "none";
    scrim.style.display = "none";
  }

  fab.addEventListener("click", () => {
    if (popover.style.display === "none") openPopover();
    else closePopover();
  });
  closeBtn.addEventListener("click", closePopover);
  scrim.addEventListener("click", closePopover);
  document.addEventListener("click", (e) => {
    if (popover.style.display === "none") return;
    if (popover.contains(e.target) || fab.contains(e.target)) return;
    closePopover();
  });

  btn.addEventListener("click", async () => {
    btn.disabled = true;
    result.style.display = "none";
    loading.style.display = "flex";
    msg.textContent = "";
    msg.classList.remove("error");
    try {
      const res = await fetch("/api/ai-analyze", { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "分析失敗");
      result.textContent = json.analysis;
      result.style.display = "block";
    } catch (e) {
      msg.textContent = e.message;
      msg.classList.add("error");
    } finally {
      loading.style.display = "none";
      btn.disabled = false;
    }
  });
})();

// ---- 平滑展開/收合 <details> 手風琴，取代原生的瞬間開關 ----
document.querySelectorAll(".panel-block > summary").forEach((summary) => {
  const details = summary.parentElement;
  const content = Array.from(details.children).filter((c) => c !== summary);
  summary.addEventListener("click", (e) => {
    e.preventDefault();
    const opening = !details.open;
    if (opening) {
      details.open = true;
      const targetHeight = content.reduce((h, el) => h + el.offsetHeight, 0);
      content.forEach((el) => {
        el.style.overflow = "hidden";
        el.style.maxHeight = "0px";
        el.style.transition = "max-height 0.28s var(--ease), opacity 0.2s ease";
        el.style.opacity = "0";
      });
      requestAnimationFrame(() => {
        content.forEach((el) => {
          el.style.maxHeight = `${el.scrollHeight}px`;
          el.style.opacity = "1";
        });
      });
      setTimeout(() => content.forEach((el) => (el.style.maxHeight = "")), 320);
    } else {
      content.forEach((el) => {
        el.style.overflow = "hidden";
        el.style.maxHeight = `${el.scrollHeight}px`;
        el.style.transition = "max-height 0.28s var(--ease), opacity 0.2s ease";
      });
      requestAnimationFrame(() => {
        content.forEach((el) => {
          el.style.maxHeight = "0px";
          el.style.opacity = "0";
        });
      });
      setTimeout(() => (details.open = false), 280);
    }
  });
});

// ---- 模擬考成績 + 手刻 SVG 折線圖 ----
bindForm(
  "mockExamForm",
  "mockExamMsg",
  "/api/mock-exams",
  (d) => ({
    name: d.name,
    date: d.date,
    chinese: d.chinese || undefined,
    mathA: d.mathA || undefined,
    science: d.science || undefined,
    english: d.english || undefined,
    notes: d.notes || undefined,
  }),
  () => loadMockExams()
);

function renderMockExamCard(e) {
  return `
  <div class="card">
    <div class="row">
      <span class="title">${esc(e.name)}</span>
      <span class="status-badge">總級分 ${e.total ?? "-"}</span>
    </div>
    <div class="subject">${esc(e.date || "")}</div>
    <div class="stats">
      <span style="color:var(--subject-國文)">國文 <b>${e.chinese ?? "-"}</b></span>
      <span style="color:var(--subject-數A)">數A <b>${e.mathA ?? "-"}</b></span>
      <span style="color:var(--subject-自然)">自然 <b>${e.science ?? "-"}</b></span>
      <span style="color:var(--subject-英文)">英文 <b>${e.english ?? "-"}</b></span>
    </div>
    ${e.notes ? `<div class="explanation-box">${esc(e.notes)}</div>` : ""}
  </div>`;
}

// 純手刻 inline SVG 折線圖，不依賴任何圖表套件。畫總級分 + 四科各自的趨勢線
function renderMockExamChart(exams) {
  if (!exams.length) return '<p class="loading">還沒有模擬考成績，新增後這裡會畫出趨勢圖</p>';

  const width = 320;
  const height = 200;
  const padding = { top: 16, right: 12, bottom: 28, left: 28 };
  const innerW = width - padding.left - padding.right;
  const innerH = height - padding.top - padding.bottom;

  const series = [
    { key: "total", label: "總級分", color: "var(--accent)", max: 60 },
    { key: "chinese", label: "國文", color: "var(--subject-國文)", max: 15 },
    { key: "mathA", label: "數A", color: "var(--subject-數A)", max: 15 },
    { key: "science", label: "自然", color: "var(--subject-自然)", max: 15 },
    { key: "english", label: "英文", color: "var(--subject-英文)", max: 15 },
  ];

  const n = exams.length;
  const xAt = (i) => padding.left + (n === 1 ? innerW / 2 : (innerW * i) / (n - 1));

  function pointsFor(key, max) {
    return exams
      .map((e, i) => {
        const v = e[key];
        if (v == null) return null;
        const y = padding.top + innerH - (v / max) * innerH;
        return `${xAt(i)},${y}`;
      })
      .filter(Boolean)
      .join(" ");
  }

  const lines = series
    .map((s) => {
      const pts = pointsFor(s.key, s.max);
      if (!pts) return "";
      return `<polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`;
    })
    .join("");

  const xLabels = exams
    .map((e, i) => `<text x="${xAt(i)}" y="${height - 8}" font-size="8" fill="var(--muted)" text-anchor="middle">${esc((e.name || "").slice(0, 4))}</text>`)
    .join("");

  const legend = series
    .map(
      (s, i) =>
        `<span style="display:inline-flex;align-items:center;gap:0.3rem;margin-right:0.8rem;font-size:0.72rem;color:var(--muted)">
          <span style="width:9px;height:9px;border-radius:50%;background:${s.color};display:inline-block"></span>${s.label}
        </span>`
    )
    .join("");

  return `
    <svg viewBox="0 0 ${width} ${height}" style="width:100%;height:auto">
      <line x1="${padding.left}" y1="${padding.top}" x2="${padding.left}" y2="${height - padding.bottom}" stroke="var(--border)" stroke-width="1"/>
      <line x1="${padding.left}" y1="${height - padding.bottom}" x2="${width - padding.right}" y2="${height - padding.bottom}" stroke="var(--border)" stroke-width="1"/>
      ${lines}
      ${xLabels}
    </svg>
    <div style="margin-top:0.4rem">${legend}</div>`;
}

let mockExamsCache = null;

async function loadMockExams() {
  const chartEl = document.getElementById("mockExamChart");
  const listEl = document.getElementById("mockExamList");
  if (mockExamsCache) {
    chartEl.innerHTML = renderMockExamChart(mockExamsCache);
    listEl.innerHTML = mockExamsCache.slice().reverse().map(renderMockExamCard).join("") || '<p class="loading">尚無紀錄</p>';
  } else {
    chartEl.innerHTML = '<p class="loading">載入中...</p>';
    listEl.innerHTML = skeletonCards(2);
  }
  try {
    const res = await fetch("/api/mock-exams");
    mockExamsCache = await res.json();
    chartEl.innerHTML = renderMockExamChart(mockExamsCache);
    listEl.innerHTML = mockExamsCache.slice().reverse().map(renderMockExamCard).join("") || '<p class="loading">尚無紀錄</p>';
  } catch (e) {
    if (!mockExamsCache) {
      chartEl.innerHTML = `<p class="loading">載入失敗：${esc(e.message)}</p>`;
      listEl.innerHTML = "";
    }
  }
}

loadUnits();
loadDashboard();
