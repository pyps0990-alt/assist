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

async function loadUnits() {
  const res = await fetch("/api/subjects");
  const subjects = await res.json();
  const selects = ["studyUnitSelect", "testUnitSelect", "wrongUnitSelect"];
  selects.forEach((id) => {
    const sel = document.getElementById(id);
    const current = sel.value;
    sel.innerHTML = '<option value="">(不指定)</option>';
    subjects.forEach((s) => {
      const opt = document.createElement("option");
      opt.value = s.id;
      opt.textContent = `${s.subject || ""} - ${s.unit}`;
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

const SUBJECT_OPTIONS = ["國文", "英文", "數學", "自然", "社會"];
const STATUS_OPTIONS = ["未開始", "進行中", "已完成", "需複習"];

function skeletonCards(n = 3) {
  return Array.from({ length: n }, () => '<div class="skeleton-card"></div>').join("");
}

const SUBJECT_ORDER = ["國文", "英文", "數學", "自然", "社會"];
const STATUS_PRIORITY = { 需複習: 0, 進行中: 1, 未開始: 2, 已完成: 3 };

// 自動排序：先依科目固定順序分組，組內把「需複習/進行中」排前面，
// 熟悉度低的（較弱的單元）優先，方便一打開就看到最需要複習的內容
function sortSubjects(subjects) {
  return [...subjects].sort((a, b) => {
    const subjectDiff = SUBJECT_ORDER.indexOf(a.subject) - SUBJECT_ORDER.indexOf(b.subject);
    if (subjectDiff !== 0) return subjectDiff;
    const statusDiff = (STATUS_PRIORITY[a.status] ?? 9) - (STATUS_PRIORITY[b.status] ?? 9);
    if (statusDiff !== 0) return statusDiff;
    const masteryDiff = (a.mastery ?? 99) - (b.mastery ?? 99);
    if (masteryDiff !== 0) return masteryDiff;
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
        <span>熟悉度 <b>${s.mastery ?? "—"}</b></span>
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

bindForm(
  "testForm",
  "testMsg",
  "/api/test-record",
  (d) => ({
    date: d.date,
    subject: d.subject,
    unitId: d.unitId || undefined,
    source: d.source,
    total: d.total,
    correct: d.correct,
    imageFileUploadId: d.imageFileUploadId || undefined,
  }),
  () => resetImagePreview("testImagePreview", "testImageFileUploadId", "testOcrMsg")
);

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
  const btn = document.getElementById("aiAnalyzeBtn");
  const msg = document.getElementById("aiAnalyzeMsg");
  const result = document.getElementById("aiAnalyzeResult");

  btn.addEventListener("click", async () => {
    btn.disabled = true;
    result.style.display = "none";
    msg.textContent = "分析中，可能需要幾秒鐘...";
    msg.classList.remove("error");
    try {
      const res = await fetch("/api/ai-analyze", { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "分析失敗");
      result.textContent = json.analysis;
      result.style.display = "block";
      msg.textContent = "";
    } catch (e) {
      msg.textContent = e.message;
      msg.classList.add("error");
    } finally {
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

loadUnits();
loadDashboard();
