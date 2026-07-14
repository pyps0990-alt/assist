# 學測複習進度追蹤

手機也能用的網頁，資料直接同步到 Notion，不用開 Notion 就能記錄讀書進度、考卷成績、錯題。

## 設定步驟

1. 到 https://www.notion.so/my-integrations 建立一個新的 internal integration，取得 **Internal Integration Secret**（開頭 `ntn_` 或 `secret_`）
2. 打開 Notion 裡的「學測複習進度追蹤」頁面 → 右上角 `...` → **Connections** → 把剛剛建立的 integration 加進去（授權它存取這個頁面與底下四個資料庫）
3. 複製 `.env.example` 為 `.env`，把 `NOTION_TOKEN` 填入剛剛拿到的 secret
4. 安裝套件並啟動：
   ```
   npm install
   npm start
   ```
5. 電腦瀏覽器打開 http://localhost:3000 即可使用
6. 手機要用：確保手機和電腦在同一個 Wi-Fi，瀏覽器打開 `http://<電腦的區域網路IP>:3000`（例如 `http://192.168.1.5:3000`）。可用 `ipconfig` 查看電腦的 IPv4 位址。

## 功能

- **總覽**：各單元的正確率、累積讀書時數、熟悉度（讀自 Notion rollup）
- **讀書紀錄**：新增一筆讀書時數與摘要
- **考卷紀錄**：新增總題數/答對題數，正確率由 Notion formula 自動算
- **錯題本**：新增錯題與錯誤原因，列出最近錯題
