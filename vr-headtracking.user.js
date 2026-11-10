// ==UserScript==
// @name         360° 播放器耳機頭追
// @namespace    headphone-head-tracking-360
// @version      3.0
// @description  用支援頭部追蹤的耳機（經 HeadTracker App）在網頁 360° 播放器內模擬拖曳轉視角。A / D 調高 / 調低靈敏度，S 視角回正，Esc 全部關閉，F 重新開啟
// @match        *://*/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

// 預設對所有網站載入，但只有偵測到符合 PLAYER_SELECTOR 的播放器才會動作。
// 建議在 Tampermonkey 這個腳本的「設定 → 使用者比對（User matches）」只留你要用的網站。

(() => {
  'use strict';

  // ---- 設定 ----
  // 播放器偵測規則：預設對應「.screen > #content > canvas」結構、右上角有 .angleElem 指南針的 WebGL 360° 播放器。
  // 其他播放器請依它的 HTML 結構修改。
  const PLAYER_SELECTOR = '.screen #content canvas';
  const PLAYER_MARKER = '.angleElem';            // 頁面上還必須有這個元素才算（避免誤判一般 canvas）；不需要就設成 ''
  const PLAY_BUTTON_SELECTOR = 'svg.playStart';  // 播放鍵，偵測到會自動按；沒有就設成 ''

  const WS_URL = 'ws://127.0.0.1:4243';  // HeadTracker App 送角度的位址
  const VFOV = 60;                         // 播放器垂直視角（常見 WebGL 播放器預設 60°），靈敏度 1.0 ≈ 頭轉多少畫面轉多少
  const SMOOTH = 0.45;                     // 每幀往目標角度靠近的比例，越小越平滑但越慢
  const EVENT_KIND = 'mouse';              // 'mouse' | 'pointer' | 'both'：模擬哪種拖曳事件
  const HIDE_CURSOR = true;
  const REAL_FULLSCREEN = true;            // 第一次點擊時切成真正全螢幕

  const MSG = 'apt-vr';
  const isTop = window === window.top;

  // ---- 樣式 ----
  const style = document.createElement('style');
  style.textContent = `
    .screen.apt-fs {
      position: fixed !important; inset: 0 !important; margin: 0 !important;
      width: 100vw !important; height: 100vh !important;
      z-index: 2147483646 !important; background: #000 !important;
    }
    .apt-fs #content { position: relative !important; }
    .apt-fs #content,
    .apt-fs #content > div:first-child,
    .apt-fs #content canvas { width: 100% !important; height: 100% !important; }
    .apt-fs #content canvas { object-fit: contain; }
    .apt-nocursor, .apt-nocursor * { cursor: none !important; }
    iframe.apt-fs-frame {
      position: fixed !important; inset: 0 !important;
      width: 100vw !important; height: 100vh !important;
      z-index: 2147483646 !important; border: 0 !important; background: #000 !important;
    }
    #apt-toast {
      position: fixed; left: 50%; bottom: 40px; transform: translateX(-50%);
      z-index: 2147483647; padding: 8px 16px; border-radius: 8px;
      background: rgba(0,0,0,.75); color: #fff; font: 14px/1.4 -apple-system, sans-serif;
      pointer-events: none; transition: opacity .3s; opacity: 0;
    }
    #apt-hud {
      position: fixed; top: 12px; right: 16px; z-index: 2147483647;
      color: rgba(255,255,255,.45); font: 12px/1.6 -apple-system, sans-serif;
      text-align: right; text-shadow: 0 1px 2px rgba(0,0,0,.6);
      pointer-events: none; user-select: none; display: none;
    }
    #apt-hud b { color: rgba(255,255,255,.7); font-weight: 600; }
  `;
  (document.head || document.documentElement).appendChild(style);

  // ---- 提示訊息 ----
  let toastTimer;
  function toast(text) {
    let el = document.getElementById('apt-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'apt-toast';
      document.documentElement.appendChild(el);
    }
    el.textContent = text;
    el.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.style.opacity = '0'; }, 1800);
  }

  // ---- 右上角按鍵提示 ----
  let hudConnected = false;
  function updateHud() {
    let el = document.getElementById('apt-hud');
    if (!el) {
      el = document.createElement('div');
      el.id = 'apt-hud';
      document.documentElement.appendChild(el);
    }
    el.style.display = active ? 'block' : 'none';
    el.innerHTML =
      `頭追 ${hudConnected ? '●' : '○ 未連線'}　靈敏度 <b>${sens.toFixed(1)}×</b><br>` +
      'A 靈敏度＋　D 靈敏度－　S 視角回正　\\ 重設靈敏度　Esc 全關（F 再開）';
  }

  // ---- 靈敏度 ----
  const loadSens = () => {
    try { return parseFloat(localStorage.getItem('apt-sens')) || 1.0; } catch { return 1.0; }
  };
  let sens = loadSens();
  function setSens(value) {
    sens = Math.round(Math.min(5, Math.max(0.1, value)) * 10) / 10;
    try { localStorage.setItem('apt-sens', String(sens)); } catch {}
    toast(`靈敏度 ${sens.toFixed(1)}×`);
    updateHud();
  }

  // ---- 狀態 ----
  let enabled = true;    // Esc 關掉、F 打開
  let active = null;     // 目前放大中的 .screen
  let canvas = null;

  const findScreen = () => {
    if (PLAYER_MARKER && !document.querySelector(PLAYER_MARKER)) return null;
    return document.querySelector(PLAYER_SELECTOR)?.closest('.screen') ?? null;
  };

  // 讓播放器依新尺寸重新算畫面（播放器有監聽 resize 的話）
  const nudgeResize = () => {
    window.dispatchEvent(new Event('resize'));
    setTimeout(() => window.dispatchEvent(new Event('resize')), 300);
  };

  // ---- 放大 / 縮回 ----
  function enter(screen) {
    if (active === screen) return;
    active = screen;
    canvas = screen.querySelector(PLAYER_SELECTOR) || screen.querySelector('canvas');
    screen.classList.add('apt-fs');
    if (HIDE_CURSOR) document.documentElement.classList.add('apt-nocursor');
    if (!isTop) window.parent.postMessage({ type: MSG, cmd: 'frame-fs', on: true }, '*');
    nudgeResize();
    subscribe(true);
    updateHud();
  }

  function leave() {
    stopDrag();
    subscribe(false);
    if (active) active.classList.remove('apt-fs');
    active = null;
    canvas = null;
    document.documentElement.classList.remove('apt-nocursor');
    if (!isTop) window.parent.postMessage({ type: MSG, cmd: 'frame-fs', on: false }, '*');
    nudgeResize();
    updateHud();
  }

  function allOff() {
    if (!enabled) return;
    enabled = false;
    leave();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    if (isTop) broadcastToFrames({ type: MSG, cmd: 'off' });
    toast('頭追已全部關閉（按 F 重新開啟）');
  }

  function allOn() {
    enabled = true;
    const screen = findScreen();
    if (screen) {
      enter(screen);
      if (REAL_FULLSCREEN && !document.fullscreenElement) {
        document.documentElement.requestFullscreen?.().catch(() => {});
      }
    }
    if (isTop) broadcastToFrames({ type: MSG, cmd: 'on' });
    toast('頭追開啟');
  }

  // ---- 角度資料：最上層頁面連 App，再轉給 iframe（iframe 直接連本機可能被 Chrome 擋）----
  let ws = null;
  let retryTimer = null;
  let wantLocal = false;
  const childSubscribers = new Set();
  let wsConnected = false;

  function subscribe(on) {
    if (isTop) { wantLocal = on; updateWs(); }
    else window.parent.postMessage({ type: MSG, cmd: 'subscribe', on }, '*');
  }

  function updateWs() {
    const want = wantLocal || childSubscribers.size > 0;
    if (want && !ws) connectWs();
    if (!want && ws) {
      clearTimeout(retryTimer);
      const old = ws; ws = null; old.close();
      wsConnected = false;
    }
  }

  function connectWs() {
    clearTimeout(retryTimer);
    let sock;
    try { sock = new WebSocket(WS_URL); } catch { scheduleRetry(); return; }
    ws = sock;
    sock.onopen = () => { wsConnected = true; notifyStatus(true); };
    sock.onmessage = (e) => {
      let data;
      try { data = JSON.parse(e.data); } catch { return; }
      if (wantLocal) onAngles(data.y, data.p);
      for (const child of childSubscribers) child.postMessage({ type: MSG, cmd: 'angles', y: data.y, p: data.p }, '*');
    };
    sock.onclose = () => {
      if (ws !== sock) return;  // 自己關掉的
      ws = null;
      if (wsConnected) notifyStatus(false);
      wsConnected = false;
      scheduleRetry();
    };
  }

  let warnedOffline = false;
  function scheduleRetry() {
    if (!warnedOffline) { notifyStatus(false); warnedOffline = true; }
    retryTimer = setTimeout(updateWs, 2000);
  }

  function notifyStatus(connected) {
    if (connected) warnedOffline = false;
    if (wantLocal) onStatus(connected);
    for (const child of childSubscribers) child.postMessage({ type: MSG, cmd: 'status', connected }, '*');
  }

  function broadcastToFrames(msg) {
    document.querySelectorAll('iframe').forEach((f) => { try { f.contentWindow.postMessage(msg, '*'); } catch {} });
  }

  function onStatus(connected) {
    toast(connected ? '耳機頭追已連線' : '找不到 HeadTracker，請開啟 App');
    hudConnected = connected;
    updateHud();
    if (!connected) stopDrag();
  }

  // ---- 頭部角度 → 頁面內拖曳 ----
  let lastRaw = null;                     // App 傳來的上一筆角度
  const target = { yaw: 0, pitch: 0 };    // 累積角度（處理過 ±180° 的跳動）
  const shown = { yaw: 0, pitch: 0 };     // 平滑後、已經送成拖曳的角度
  let dragging = false;
  let pos = { x: 0, y: 0 };               // 模擬的游標位置（不受螢幕邊界限制）
  // 頭追累積拖了多少像素，S 回正時原樣倒拖回去（不管播放器怎麼換算角度都準）
  const dragged = { x: 0, y: 0 };

  const pxPerViewDeg = () => (canvas?.clientHeight || window.innerHeight) / VFOV;

  const wrap180 = (d) => ((d + 540) % 360) - 180;

  function onAngles(y, p) {
    if (!enabled || !active || typeof y !== 'number' || typeof p !== 'number') return;
    if (lastRaw) {
      target.yaw += wrap180(y - lastRaw.y);
      target.pitch += p - lastRaw.p;
    }
    lastRaw = { y, p };
    if (!dragging) startDrag();
  }

  function fire(type, x, y, dx = 0, dy = 0) {
    if (!canvas) return;
    const buttons = type.endsWith('up') ? 0 : 1;
    const init = { bubbles: true, cancelable: true, composed: true, view: window,
                   clientX: x, clientY: y, screenX: x, screenY: y,
                   movementX: dx, movementY: dy, button: 0, buttons };
    const mouseType = type;
    const pointerType = type.replace('mouse', 'pointer');
    if (EVENT_KIND !== 'mouse') {
      canvas.dispatchEvent(new PointerEvent(pointerType,
        { ...init, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
    }
    if (EVENT_KIND !== 'pointer') canvas.dispatchEvent(new MouseEvent(mouseType, init));
  }

  function startDrag() {
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    pos = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    shown.yaw = target.yaw;
    shown.pitch = target.pitch;
    dragging = true;
    fire('mousedown', pos.x, pos.y);
  }

  function stopDrag() {
    if (!dragging) return;
    dragging = false;
    fire('mouseup', pos.x, pos.y);
    lastRaw = null;
  }

  // 用固定 60Hz 計時器而不是 requestAnimationFrame：分頁沒在最前面時 rAF 會暫停
  function frame() {
    if (!dragging || !canvas) return;
    const nextYaw = shown.yaw + (target.yaw - shown.yaw) * SMOOTH;
    const nextPitch = shown.pitch + (target.pitch - shown.pitch) * SMOOTH;
    const k = pxPerViewDeg() * sens;  // 頭每轉 1° 拖幾像素
    // 頭往左轉（yaw 增加）→ 往右拖，符合「抓住畫面」的拖法；方向不對可在 App 勾反轉
    const dx = (nextYaw - shown.yaw) * k;
    const dy = (nextPitch - shown.pitch) * k;
    shown.yaw = nextYaw;
    shown.pitch = nextPitch;
    if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return;
    dragged.x += dx;
    dragged.y += dy;
    pos.x += dx;
    pos.y += dy;
    fire('mousemove', pos.x, pos.y, dx, dy);
  }
  setInterval(frame, 1000 / 60);

  // 頭追拖曳中，擋掉真正的滑鼠移動 / 放開，避免和頭部角度打架
  for (const type of ['mousemove', 'mouseup', 'pointermove', 'pointerup']) {
    window.addEventListener(type, (e) => {
      if (dragging && e.isTrusted) e.stopImmediatePropagation();
    }, true);
  }

  // ---- 播放鍵（三角形）----
  // 只在頁面有播放器標記時才找播放鍵，避免在其他網站誤按
  const findPlayButton = () =>
    PLAY_BUTTON_SELECTOR && (!PLAYER_MARKER || document.querySelector(PLAYER_MARKER))
      ? [...document.querySelectorAll(PLAY_BUTTON_SELECTOR)].find((el) => el.getClientRects().length > 0)
      : undefined;

  const autoPressed = new WeakSet();
  let retryButton = null;  // 自動按了但還在畫面上（播放被擋），等第一次點擊再按一次

  // 視角回正：把頭追累積的拖曳一次倒拖回去，頭現在的方向就變成正前方
  // （播放器的指南針只認真正的點擊，模擬點擊沒用，所以不靠它）
  function recenterView() {
    if (!dragging) return;
    const dx = -dragged.x;
    const dy = -dragged.y;
    pos.x += dx;
    pos.y += dy;
    fire('mousemove', pos.x, pos.y, dx, dy);
    dragged.x = 0;
    dragged.y = 0;
    toast('視角回正');
  }

  // 手動點指南針時播放器已經回正，累積量跟著歸零
  document.addEventListener('click', (e) => {
    if (e.isTrusted && e.target.closest?.('.angleElem')) { dragged.x = 0; dragged.y = 0; }
  }, true);

  // 模擬一次完整點擊，讓掛在按鈕或它外層的監聽器都收得到
  function pressPlay(button) {
    const rect = button.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, view: window,
                   clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      const Ctor = type.startsWith('pointer') ? PointerEvent : MouseEvent;
      button.dispatchEvent(new Ctor(type, opts));
    }
  }

  // ---- 偵測播放器出現 ----
  const check = () => {
    if (!enabled) return;
    const button = findPlayButton();
    if (button && !autoPressed.has(button)) {
      autoPressed.add(button);
      pressPlay(button);
      // Chrome 可能因為沒有使用者手勢而擋掉播放；按鈕還在就等第一次點擊補按
      setTimeout(() => { if (findPlayButton() === button) retryButton = button; }, 800);
    }
    const screen = findScreen();
    if (screen && screen !== active) enter(screen);
  };
  new MutationObserver(check).observe(document.documentElement, { childList: true, subtree: true });
  check();

  // 真正的點擊算使用者手勢：補按播放、切成真正的全螢幕，並把頭追拖曳重新對齊
  window.addEventListener('mousedown', (e) => {
    if (!e.isTrusted) return;
    if (retryButton && retryButton.isConnected && !retryButton.contains(e.target)) pressPlay(retryButton);
    retryButton = null;
    if (REAL_FULLSCREEN && active && enabled && !document.fullscreenElement) {
      document.documentElement.requestFullscreen?.().catch(() => {});
    }
    if (dragging) setTimeout(() => fire('mousedown', pos.x, pos.y), 0);
  }, true);

  // 全螢幕時按 Esc，瀏覽器會自己退出全螢幕、頁面收不到按鍵，所以也從這裡全部關閉
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && active) allOff();
  });

  // ---- 按鍵 ----
  // 只有這頁（或它的 iframe）有播放器才處理按鍵，不影響其他網站的快速鍵
  let hasPlayerFrame = false;
  const pageHasPlayer = () => !!findScreen() || (isTop && hasPlayerFrame);

  function handleKey(key) {
    if (!pageHasPlayer()) return false;
    if (key === 'Escape') allOff();
    else if (key === 'f' || key === 'F') { if (!enabled || !active) allOn(); }
    else if (key === 'a' || key === 'A') setSens(sens + 0.1);
    else if (key === 'd' || key === 'D') setSens(sens - 0.1);
    else if (key === '\\') setSens(1.0);
    else if (key === 's' || key === 'S') { if (active) recenterView(); }
    else return false;
    return true;
  }

  window.addEventListener('keydown', (e) => {
    if (e.target.closest?.('input, textarea, [contenteditable]')) return;
    // 播放器在 iframe 裡、焦點在外層時，把按鍵轉給 iframe（靈敏度存在 iframe 那邊）
    if (isTop && !active && document.querySelector('iframe.apt-fs-frame')) {
      if (['a', 'A', 'd', 'D', 's', 'S', '\\'].includes(e.key)) {
        broadcastToFrames({ type: MSG, cmd: 'key', key: e.key });
        e.preventDefault();
        return;
      }
    }
    if (handleKey(e.key) && active) e.preventDefault();
  }, true);

  // ---- 外層與 iframe 之間的訊息 ----
  window.addEventListener('message', (e) => {
    const data = e.data;
    if (data?.type !== MSG) return;
    if (isTop) {
      if (data.cmd === 'frame-fs') {
        const frame = [...document.querySelectorAll('iframe')].find((f) => f.contentWindow === e.source);
        if (frame) { frame.classList.toggle('apt-fs-frame', data.on); hasPlayerFrame = true; }
      } else if (data.cmd === 'subscribe') {
        if (data.on) childSubscribers.add(e.source); else childSubscribers.delete(e.source);
        updateWs();
        if (data.on && wsConnected) e.source.postMessage({ type: MSG, cmd: 'status', connected: true }, '*');
      }
    } else if (e.source === window.parent) {
      if (data.cmd === 'angles') onAngles(data.y, data.p);
      else if (data.cmd === 'status') onStatus(data.connected);
      else if (data.cmd === 'key') handleKey(data.key);
      else if (data.cmd === 'off') allOff();
      else if (data.cmd === 'on' && !enabled) allOn();
    }
  });
})();
