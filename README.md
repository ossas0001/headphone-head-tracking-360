# headphone-head-tracking-360

用**支援頭部追蹤的耳機**當頭部追蹤器：轉頭就能看網頁 360° 影片 / 全景播放器的四周，也可以把頭追資料送給 [opentrack](https://github.com/opentrack/opentrack) 玩飛行模擬、賽車遊戲。

> Turn head-tracking headphones into a head tracker on macOS: look around browser-based 360° players with your head, or feed opentrack via UDP.

相容的耳機是 macOS CoreMotion `CMHeadphoneMotionManager` 支援的機種，例如 Apple AirPods Pro、AirPods Max、AirPods（第 3 代以上）與部分 Beats 耳機。

## 運作方式

```
耳機（陀螺儀）
   │  CoreMotion：CMHeadphoneMotionManager
   ▼
HeadTracker（macOS App）
   ├─ ws://127.0.0.1:4243 ──► 瀏覽器使用者腳本 ──► 在播放器內模擬拖曳轉視角
   └─ UDP 4242 ───────────► opentrack ──► 遊戲 / 模擬器
```

瀏覽器沒有讀取耳機陀螺儀的 API，所以由一個小 App 讀取頭部角度，透過**只在本機**的連線交給網頁腳本。腳本在播放器內部模擬滑鼠拖曳，不會移動真正的滑鼠，也不需要「輔助使用」權限。

## 功能

- 偵測到播放器就自動按播放、撐滿視窗、隱藏游標，第一次點擊切成真正全螢幕
- 頭部角度平滑成 60Hz 拖曳，可以 360° 一直轉，不會卡在螢幕邊緣
- 頭追時忽略實體滑鼠移動，避免互相干擾
- 右上角半透明提示：連線狀態、目前靈敏度、按鍵說明
- 靈敏度可調並記住；一鍵視角回正；Esc 一鍵全部關閉

## 需求

- macOS 14 以上，以及上述相容耳機
- Xcode 或 Command Line Tools（用來編譯 App）
- Chrome + [Tampermonkey](https://www.tampermonkey.net/)

## 安裝

### 1. 編譯 App

```bash
git clone https://github.com/ossas0001/headphone-head-tracking-360.git
cd headphone-head-tracking-360
./build.sh
```

把產生的 `HeadTracker.app` 拖進「應用程式」資料夾並開啟。第一次會詢問「動作與健身」權限，請允許。

### 2. 安裝使用者腳本

1. Chrome 安裝 Tampermonkey，到 `chrome://extensions` → Tampermonkey →「詳細資料」→ 打開「**允許使用者指令碼**」。
2. 打開 [`vr-headtracking.user.js`](vr-headtracking.user.js) 的 Raw 頁面安裝，或在 Tampermonkey「建立新腳本」貼上內容後存檔。
3. **建議**在 Tampermonkey 這個腳本的「設定 → 使用者比對（User matches）」只加入你要使用的網站，並把預設的 `*://*/*` 排除。

## 使用

1. 開啟 HeadTracker，戴上耳機。
2. 打開有 360° 播放器的頁面，偵測到播放器後會自動開始頭追。
3. Chrome 第一次可能會詢問是否允許網站「存取這部裝置上的其他應用程式」，請允許（腳本要連到本機的 App）。

| 按鍵 | 功能 |
|---|---|
| `A` / `D` | 靈敏度 +0.1 / −0.1（會記住） |
| `S` | 視角回正（頭現在的方向變成正前方） |
| `\` | 靈敏度回到 1.0（≈ 頭轉多少畫面轉多少） |
| `Esc` | 全部關閉：頭追、全螢幕、游標隱藏 |
| `F` | 全部重新開啟 |

按鍵只在偵測到播放器的頁面有效，不影響其他網站。方向相反時，在 App 勾「反轉 Yaw / Pitch」。

### 對應其他播放器

腳本開頭的設定：

| 設定 | 說明 |
|---|---|
| `PLAYER_SELECTOR` | 播放器 canvas 的選擇器（預設 `.screen #content canvas`） |
| `PLAYER_MARKER` | 頁面上必須同時存在的元素，避免誤判（預設 `.angleElem`） |
| `PLAY_BUTTON_SELECTOR` | 自動按的播放鍵（預設 `svg.playStart`，不需要就設成 `''`） |
| `SMOOTH` / `EVENT_KIND` | 平滑度 / 模擬 `mouse` 或 `pointer` 事件 |

用滑鼠拖曳轉視角的 WebGL 360° 播放器，依它的 HTML 結構改這幾個選擇器通常就能用。

## 搭配 opentrack

App 也會用 opentrack 的「UDP over network」格式送出角度（6 個 little-endian double：x, y, z, yaw, pitch, roll）。

- opentrack 的 Input 選 **UDP over network**，port 4242。
- opentrack 在另一台電腦時，在 App 填那台電腦的區網 IP。
- 沒有 opentrack 也可以用 `python3 listen.py` 看收到的數值。

## 限制

- 只有旋轉（3DoF），沒有位置移動。
- 耳機頭追資料更新率大約 25Hz。
- App 用 ad-hoc 簽章，重新編譯後 macOS 可能要重新允許權限。
- App 裡的「滑鼠拖曳模式」（⌃⌥D）是舊做法，會操作真正的滑鼠並需要「輔助使用」權限；網頁上建議用使用者腳本。

## 隱私

- 頭部角度只在你的電腦上處理：App 的 WebSocket 只接受本機（loopback）連線，腳本只連 `127.0.0.1`。opentrack 的 UDP 預設也只送到本機，除非你自己填了其他電腦的 IP。
- 不收集、不上傳任何資料，沒有分析或追蹤程式。

## 免責聲明

- 本專案是個人的輔助工具與技術示範，**僅在你自己的瀏覽器中**改變頁面的顯示與操作方式。
- 本專案**不會**下載、錄製、擷取或轉存任何影片內容，也**不會**繞過任何 DRM、付費牆、登入或存取控制。
- 使用者須自行確認並遵守所使用網站的服務條款與所在地法律；作者不對使用本專案造成的任何後果負責。
- 本專案與 Apple、opentrack 或任何網站、影音服務都沒有關係，也未經其認可。AirPods、Beats 是 Apple Inc. 的商標，文中提及僅用於說明相容性。
- 本軟體依 MIT 授權「按現狀」提供，不附任何形式的保證。

## 授權

[MIT](LICENSE)
