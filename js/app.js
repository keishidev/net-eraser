// app.js — UI専任 (処理は js/worker.js)
// UX: 読み込んだ瞬間に元画像を表示し、その上に進捗オーバーレイ。
//     完了後: 濃さスライダー / 長押しで元画像比較 / 保護ブラシ。
"use strict";

(() => {
const $ = id => document.getElementById(id);
const drop = $("drop"), fileIn = $("file"), status = $("status");
const view = $("view"), setup = $("setup"), canvas = $("canvas"), detail = $("detail");
const overlay = $("overlay"), ovtext = $("ovtext"), ovbar = $("ovbar");
const fade = $("fade"), fadeval = $("fadeval");

let orig = null, result = null, alphaMap = null;
let W = 0, H = 0, dispScale = 1;
let origDisp = null, resultDisp = null, alphaDisp = null;
let protectDisp = null, eraseDisp = null;   // 保護(赤) / 消し指定(緑・適用前)
let worker = null, busy = false, ready = false;
let brushMode = "none";                     // "none" | "protect" | "erase"
let showProtect = true, showMask = false, holdCompare = false;

function setStatus(t) { status.textContent = t || ""; }
function setOverlay(show, text, pct) {
  overlay.hidden = !show;
  if (text != null) ovtext.textContent = text;
  if (pct != null) { ovbar.hidden = false; ovbar.value = pct; }
  else ovbar.hidden = true;
}

function getWorker() {
  if (!worker) worker = new Worker("js/worker.js?v=18");
  return worker;
}

/* ===== 起動時GPUチェック ===== */
(async () => {
  const el = $("gpustatus");
  try {
    if (!navigator.gpu) throw new Error("no webgpu");
    const ad = await navigator.gpu.requestAdapter();
    if (!ad) throw new Error("no adapter");
    const info = ad.info || {};
    const name = [info.description, info.device, info.vendor, info.architecture]
      .filter(v => v && String(v).trim()).map(String)[0] || "";
    el.textContent = `✅ WebGPUが使えます${name ? "（" + name + "）" : ""} — 高速に処理できます`;
    el.className = "gpustatus ok";
  } catch (_) {
    el.textContent = "⚠️ WebGPU非対応のため、CPUでゆっくり動作します。仕上がりは「⚡標準」がおすすめです";
    el.className = "gpustatus warn";
    // 非対応環境では標準モデルを既定に
    const mg = document.querySelector('input[name=model][value=migan]');
    if (mg) mg.checked = true;
  }
})();

/* ===== ファイル受け付け ===== */
drop.addEventListener("click", async () => {
  // Chrome系: ピクチャフォルダから開始(2回目以降は前回の場所を記憶)
  if (window.showOpenFilePicker) {
    try {
      const [h] = await window.showOpenFilePicker({
        id: "net-eraser",
        startIn: "pictures",
        multiple: false,
        types: [{ description: "画像", accept: { "image/*": [".jpg", ".jpeg", ".png", ".webp"] } }],
      });
      handleFile(await h.getFile());
    } catch (_) { /* キャンセル時は何もしない */ }
  } else {
    fileIn.click();   // 非対応ブラウザは従来のダイアログ
  }
});
drop.addEventListener("dragover", e => { e.preventDefault(); drop.classList.add("hover"); });
drop.addEventListener("dragleave", () => drop.classList.remove("hover"));
drop.addEventListener("drop", e => {
  e.preventDefault(); drop.classList.remove("hover");
  if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
});
fileIn.addEventListener("change", () => { if (fileIn.files[0]) handleFile(fileIn.files[0]); });

async function handleFile(file) {
  if (busy) return;
  if (window.AUTH_OK === false) return;   // 認証ゲート
  busy = true; ready = false;
  try {
    const mode = document.querySelector("input[name=mode]:checked").value;
    const modelKey = document.querySelector("input[name=model]:checked").value;
    const img = await loadImage(file);
    W = img.width; H = img.height;

    // フル解像度RGBA (JS側のみ)
    const c = document.createElement("canvas");
    c.width = W; c.height = H;
    const cx = c.getContext("2d", { willReadFrequently: true });
    cx.drawImage(img, 0, 0);
    const fullData = cx.getImageData(0, 0, W, H);
    orig = fullData.data.slice();

    // すぐに編集画面へ: 元画像を表示して進捗オーバーレイ
    setup.hidden = true; view.hidden = false;
    $("controlbar").dataset.disabled = "1";
    buildOrigOnlyDisplay();
    setOverlay(true, "読み込んでいます…", null);

    // 開発用: ?fake=1 で推論スキップ
    if (location.search.includes("fake=1")) {
      result = orig.slice();
      alphaMap = new Float32Array(W * H);
      finishReady({ detMs: 0, inMs: 0, bufMs: 0, sweepMs: 0, ep: "fake" }, 0);
      return;
    }

    const smallData = scaleImageData(img, Math.min(1600, W), null);
    const midData = mode === "kirara" ? scaleImageData(img, null, 2048) : null;

    const wk = getWorker();
    const t0 = performance.now();
    const done = new Promise((res, rej) => {
      wk.onmessage = ev => {
        const m = ev.data;
        if (m.type === "progress") setOverlay(true, m.text, m.pct);
        else if (m.type === "done") res(m);
        else if (m.type === "error") rej(new Error(m.message));
      };
      wk.onerror = ev => rej(new Error(ev.message || "worker error"));
    });
    const fullBuf = fullData.data.buffer;
    wk.postMessage({
      type: "process", W, H, kirara: mode === "kirara", model: modelKey,
      full: fullBuf,
      small: { buf: smallData.data.buffer, w: smallData.width, h: smallData.height },
      mid: midData ? { buf: midData.data.buffer, w: midData.width, h: midData.height } : null,
    }, [fullBuf, smallData.data.buffer].concat(midData ? [midData.data.buffer] : []));

    const m = await done;
    result = new Uint8ClampedArray(m.result);
    alphaMap = new Float32Array(m.alpha);
    finishReady(m.stats, (performance.now() - t0) / 1000);
  } catch (e) {
    console.error(e);
    setOverlay(true, "エラー: " + (e.message || String(e)), null);
    busy = false;
  }
}

function finishReady(s, totalSec) {
  buildDisplayCache();
  render();
  setOverlay(false);
  $("controlbar").dataset.disabled = "0";
  ready = true; busy = false;
  if (!localStorage.getItem("flowguide_done")) $("flowguide").hidden = false;
  const engine = s.ep === "webgpu" ? "GPU" : s.ep === "wasm" ? "CPU" : s.ep;
  detail.textContent = totalSec
    ? `処理時間 ${totalSec.toFixed(1)}秒（検出 ${(s.detMs / 1000).toFixed(1)}s・ネット消し ${(s.inMs / 1000).toFixed(1)}s` +
      (s.bufMs ? `・整え ${(s.bufMs / 1000).toFixed(1)}s` : "") +
      (s.sweepMs ? `・掃除 ${(s.sweepMs / 1000).toFixed(1)}s` : "") +
      ` ／ ${engine}実行）`
    : "";
}

function loadImage(file) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = URL.createObjectURL(file);
  });
}

function scaleImageData(img, targetW, targetLong) {
  let w, h;
  if (targetLong) {
    const sc = Math.min(1, targetLong / Math.max(img.width, img.height));
    w = Math.round(img.width * sc); h = Math.round(img.height * sc);
  } else {
    w = Math.min(targetW, img.width);
    h = Math.round(img.height * w / img.width);
  }
  const c = new OffscreenCanvas(w, h);
  const cx = c.getContext("2d", { willReadFrequently: true });
  cx.drawImage(img, 0, 0, w, h);
  return cx.getImageData(0, 0, w, h);
}

/* ===== 表示 ===== */
function buildOrigOnlyDisplay() {
  dispScale = Math.min(1, 1600 / W);
  const dw = Math.round(W * dispScale), dh = Math.round(H * dispScale);
  canvas.width = dw; canvas.height = dh;
  origDisp = scaleRGBA(orig, W, H, dw, dh);
  resultDisp = null; alphaDisp = null;
  protectDisp = new Float32Array(dw * dh);
  eraseDisp = new Float32Array(dw * dh);
  canvas.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(origDisp), dw, dh), 0, 0);
}

function buildDisplayCache() {
  const dw = canvas.width, dh = canvas.height;
  resultDisp = scaleRGBA(result, W, H, dw, dh);
  alphaDisp = scaleAlpha(alphaMap, W, H, dw, dh);
  if (!protectDisp || protectDisp.length !== dw * dh) protectDisp = new Float32Array(dw * dh);
}

function scaleRGBA(data, w, h, dw, dh) {
  const c1 = new OffscreenCanvas(w, h);
  c1.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(data), w, h), 0, 0);
  const c2 = new OffscreenCanvas(dw, dh);
  const cx = c2.getContext("2d", { willReadFrequently: true });
  cx.drawImage(c1, 0, 0, dw, dh);
  return cx.getImageData(0, 0, dw, dh).data;
}
function scaleAlpha(a, w, h, dw, dh) {
  const out = new Float32Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(h - 1, Math.round(y / dispScale));
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(w - 1, Math.round(x / dispScale));
      out[y * dw + x] = a[sy * w + sx];
    }
  }
  return out;
}

function render() {
  if (!resultDisp) return;
  const beta = (+fade.value) / 100;
  fadeval.textContent = fade.value + "%";
  const dw = canvas.width, dh = canvas.height;
  const out = new Uint8ClampedArray(resultDisp.length);
  if (holdCompare) out.set(origDisp);
  else {
    for (let i = 0, p = 0; i < dw * dh; i++, p += 4) {
      const a = alphaDisp[i];
      const wgt = beta * a;
      let r = resultDisp[p]     * (1 - wgt) + origDisp[p]     * wgt;
      let g = resultDisp[p + 1] * (1 - wgt) + origDisp[p + 1] * wgt;
      let b = resultDisp[p + 2] * (1 - wgt) + origDisp[p + 2] * wgt;
      if (showMask && a > 0.04) {   // 🔵 AIが修正した場所
        g = Math.min(255, g + 34 * a);
        b = Math.min(255, b + 95 * a);
      }
      const ev = eraseDisp[i];
      if (ev > 0) {                 // 🧽 消し指定(適用前)は緑
        g = Math.min(255, g + 85 * ev);
        r = r * (1 - 0.15 * ev);
      }
      const pv = protectDisp[i];
      if (pv > 0) {                 // 🖌 保護(最優先)
        r = r * (1 - pv) + origDisp[p]     * pv;
        g = g * (1 - pv) + origDisp[p + 1] * pv;
        b = b * (1 - pv) + origDisp[p + 2] * pv;
        if (showProtect) { r = Math.min(255, r + 70 * pv); b = Math.min(255, b + 20 * pv); }
      }
      out[p] = r; out[p + 1] = g; out[p + 2] = b; out[p + 3] = 255;
    }
  }
  canvas.getContext("2d").putImageData(new ImageData(out, dw, dh), 0, 0);
}

let renderQueued = false;
function queueRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}
fade.addEventListener("input", queueRender);

/* ===== 長押しで元画像比較 / 保護ブラシ ===== */
let painting = false;
const brushCursor = $("brushcursor");

function updateBrushCursor(ev) {
  if (brushMode === "none") { brushCursor.hidden = true; return; }
  brushCursor.style.borderColor = brushMode === "erase" ? "#7fe08f" : "#ff8aa0";
  const stage = $("stage").getBoundingClientRect();
  const rect = canvas.getBoundingClientRect();
  // 表示上のブラシ直径 = ブラシサイズ(canvas px) × 表示スケール
  const dia = (+$("brushsize").value) * rect.width / canvas.width;
  brushCursor.style.width = dia + "px";
  brushCursor.style.height = dia + "px";
  brushCursor.style.left = (ev.clientX - stage.left) + "px";
  brushCursor.style.top = (ev.clientY - stage.top) + "px";
  const inside = ev.clientX >= rect.left && ev.clientX <= rect.right &&
                 ev.clientY >= rect.top && ev.clientY <= rect.bottom;
  brushCursor.hidden = !inside;
}

canvas.addEventListener("dragstart", ev => ev.preventDefault());
canvas.addEventListener("pointerdown", ev => {
  if (!ready) return;
  if (brushMode !== "none" && protectDisp) {
    painting = true;
    try { canvas.setPointerCapture(ev.pointerId); } catch (_) {}
    paintAt(ev);
  } else {
    holdCompare = true;   // 長押し比較
    $("hint").textContent = "🖐 元画像を表示中(離すと戻る)";
    queueRender();
  }
  ev.preventDefault();
});
canvas.addEventListener("pointermove", ev => {
  updateBrushCursor(ev);
  if (painting && brushMode !== "none") { paintAt(ev); ev.preventDefault(); }
});
canvas.addEventListener("pointerenter", updateBrushCursor);
canvas.addEventListener("pointerout", () => { brushCursor.hidden = true; });
function endPointer() {
  painting = false;
  if (holdCompare) {
    holdCompare = false;
    $("hint").textContent = "🖐 画像を長押しで元画像と比較";
    queueRender();
  }
}
canvas.addEventListener("pointerup", endPointer);
canvas.addEventListener("pointercancel", endPointer);
canvas.addEventListener("pointerleave", () => { if (holdCompare) endPointer(); });

function paintAt(ev) {
  const layer = brushMode === "erase" ? eraseDisp : protectDisp;
  if (!layer) return;
  const rect = canvas.getBoundingClientRect();
  const cx = (ev.clientX - rect.left) * canvas.width / rect.width;
  const cy = (ev.clientY - rect.top) * canvas.height / rect.height;
  const r = (+$("brushsize").value) / 2;
  const dw = canvas.width, dh = canvas.height;
  const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(dw - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(dh - 1, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d <= r) {
        const soft = d > r * 0.7 ? (r - d) / (r * 0.3) : 1;
        const i = y * dw + x;
        if (soft > layer[i]) layer[i] = soft;
      }
    }
  }
  if (brushMode === "erase") setApplyEnabled(true);
  queueRender();
}

// ✨ボタンの有効/無効とtitleをまとめて切替
function setApplyEnabled(on) {
  const b = $("applyerase");
  b.disabled = !on;
  b.title = on ? "緑でなぞった場所をAIで消します" : "先に🧽消しツールで場所をなぞってください";
}

function setBrushMode(mode) {
  brushMode = mode;   // セグメント型: 常にどれか一つ
  $("viewtool").classList.toggle("pressed", brushMode === "none");
  $("brushbtn").classList.toggle("pressed", brushMode === "protect");
  $("erasebtn").classList.toggle("pressed", brushMode === "erase");
  $("viewtool").setAttribute("aria-pressed", String(brushMode === "none"));
  $("brushbtn").setAttribute("aria-pressed", String(brushMode === "protect"));
  $("erasebtn").setAttribute("aria-pressed", String(brushMode === "erase"));
  $("brushsize").disabled = (brushMode === "none");
  canvas.style.cursor = brushMode !== "none" ? "none" : "";
  if (brushMode === "none") brushCursor.hidden = true;
  $("hint").textContent =
    brushMode === "protect" ? "🖌 なぞった場所は変換されません(赤)" :
    brushMode === "erase"   ? "🧽 なぞった場所も消します(緑) → ✨適用" :
    "🖐 画像を押している間、元の写真が見えます";
  if (brushMode === "protect" && !showProtect) toggleShowProtect();
  queueRender();
}
$("viewtool").addEventListener("click", () => setBrushMode("none"));
$("brushbtn").addEventListener("click", () => setBrushMode("protect"));
$("erasebtn").addEventListener("click", () => setBrushMode("erase"));

/* ===== 消しブラシの適用: workerで追加インペイント ===== */
$("applyerase").addEventListener("click", async () => {
  if (!ready || busy) return;
  const dw = canvas.width, dh = canvas.height;
  const maskFull = new Uint8Array(W * H);
  let cnt = 0;
  for (let y = 0; y < H; y++) {
    const py = Math.min(dh - 1, Math.round(y * dispScale));
    for (let x = 0; x < W; x++) {
      const di = py * dw + Math.min(dw - 1, Math.round(x * dispScale));
      if (eraseDisp[di] > 0.25 && !(protectDisp[di] > 0.3)) {
        maskFull[y * W + x] = 255; cnt++;
      }
    }
  }
  if (!cnt) { setApplyEnabled(false); return; }
  busy = true;
  $("controlbar").dataset.disabled = "1";
  setOverlay(true, "指定された場所を消しています…", null);
  try {
    const wk = getWorker();
    const done = new Promise((res, rej) => {
      wk.onmessage = ev => {
        const m = ev.data;
        if (m.type === "progress") setOverlay(true, m.text, m.pct);
        else if (m.type === "moreDone") res(m);
        else if (m.type === "error") rej(new Error(m.message));
      };
      wk.onerror = ev => rej(new Error(ev.message || "worker error"));
    });
    const resBuf = result.slice().buffer;   // コピーを転送(手元は保持)
    const mBuf = maskFull.buffer;
    wk.postMessage({
      type: "more", W, H,
      model: document.querySelector("input[name=model]:checked").value,
      result: resBuf, mask: mBuf,
    }, [resBuf, mBuf]);
    const m = await done;
    result = new Uint8ClampedArray(m.result);
    const alphaDelta = new Float32Array(m.alpha);
    for (let i = 0; i < alphaMap.length; i++)
      if (alphaDelta[i] > alphaMap[i]) alphaMap[i] = alphaDelta[i];
    eraseDisp.fill(0);
    setApplyEnabled(false);
    buildDisplayCache();
    render();
    setOverlay(false);
    $("controlbar").dataset.disabled = "0";
  } catch (e) {
    console.error(e);
    setOverlay(true, "エラー: " + (e.message || String(e)), null);
  }
  busy = false;
});
$("brushsize").addEventListener("input", () => {
  if (!brushCursor.hidden) {
    const rect = canvas.getBoundingClientRect();
    const dia = (+$("brushsize").value) * rect.width / canvas.width;
    brushCursor.style.width = dia + "px";
    brushCursor.style.height = dia + "px";
  }
});
function toggleShowProtect() {
  showProtect = !showProtect;
  $("showprotectbtn").classList.toggle("pressed", showProtect);
  $("showprotectbtn").setAttribute("aria-pressed", String(showProtect));
  queueRender();
}
$("showprotectbtn").addEventListener("click", toggleShowProtect);
$("showmaskbtn").addEventListener("click", () => {
  showMask = !showMask;
  $("showmaskbtn").classList.toggle("pressed", showMask);
  $("showmaskbtn").setAttribute("aria-pressed", String(showMask));
  $("hint").textContent = showMask
    ? "🔵 青 = AIが修正した場所 ／ 🔴 赤 = 保護した場所"
    : (brushMode !== "none" ? "🖌 ブラシでなぞってください" : "🖐 画像を押している間、元の写真が見えます");
  queueRender();
});
$("clearprotect").addEventListener("click", () => {
  // 選択中ブラシのレイヤーを消す(未選択なら両方)
  if (brushMode === "erase") { eraseDisp && eraseDisp.fill(0); setApplyEnabled(false); }
  else if (brushMode === "protect") { protectDisp && protectDisp.fill(0); }
  else {
    protectDisp && protectDisp.fill(0);
    eraseDisp && eraseDisp.fill(0);
    setApplyEnabled(false);
  }
  queueRender();
});

/* ===== 保存 / リセット ===== */
$("download").addEventListener("click", () => {
  if (!ready) return;
  const beta = (+fade.value) / 100;
  const dw = canvas.width, dh = canvas.height;
  const out = new Uint8ClampedArray(result.length);
  for (let y = 0; y < H; y++) {
    const py = Math.min(dh - 1, Math.round(y * dispScale));
    for (let x = 0; x < W; x++) {
      const i = y * W + x, p = i * 4;
      const wgt = beta * alphaMap[i];
      let r = result[p]     * (1 - wgt) + orig[p]     * wgt;
      let g = result[p + 1] * (1 - wgt) + orig[p + 1] * wgt;
      let b = result[p + 2] * (1 - wgt) + orig[p + 2] * wgt;
      const pv = protectDisp[py * dw + Math.min(dw - 1, Math.round(x * dispScale))];
      if (pv > 0) {
        r = r * (1 - pv) + orig[p]     * pv;
        g = g * (1 - pv) + orig[p + 1] * pv;
        b = b * (1 - pv) + orig[p + 2] * pv;
      }
      out[p] = r; out[p + 1] = g; out[p + 2] = b; out[p + 3] = 255;
    }
  }
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  c.getContext("2d").putImageData(new ImageData(out, W, H), 0, 0);
  setOverlay(true, "JPEG生成中…", null);
  c.toBlob(b => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(b);
    a.download = `net_removed_${fade.value}pct.jpg`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 3000);
    if (location.hostname === "localhost") {
      fetch(`http://localhost:8824/save/${a.download}`, { method: "POST", body: b }).catch(() => {});
    }
    setOverlay(false);
  }, "image/jpeg", 0.95);
});

$("reset").addEventListener("click", () => {
  if (ready && !window.confirm("編集内容は失われます。別の写真に切り替えますか？")) return;
  view.hidden = true; setup.hidden = false;
  orig = result = alphaMap = origDisp = resultDisp = alphaDisp = protectDisp = null;
  ready = false;
  brushMode = "none";
  $("brushbtn").classList.remove("pressed");
  $("erasebtn").classList.remove("pressed");
  $("viewtool").classList.add("pressed");
  $("brushbtn").setAttribute("aria-pressed", "false");
  $("erasebtn").setAttribute("aria-pressed", "false");
  $("viewtool").setAttribute("aria-pressed", "true");
  $("brushsize").disabled = true;
  setApplyEnabled(false);
  canvas.style.cursor = "";
  brushCursor.hidden = true;
  setStatus("");
  fileIn.value = "";
});

/* ===== 初回フローガイド ===== */
$("flowclose").addEventListener("click", () => {
  $("flowguide").hidden = true;
  localStorage.setItem("flowguide_done", "1");
});

/* デバッグ用フック */
window.__dbg = () => {
  const n = 200000;
  let rd = 0, dd = 0, as = 0;
  if (result && orig) for (let i = 0; i < n; i++) rd += Math.abs(result[i] - orig[i]);
  if (resultDisp && origDisp) for (let i = 0; i < n; i++) dd += Math.abs(resultDisp[i] - origDisp[i]);
  if (alphaMap) for (let i = 0; i < n; i++) as += alphaMap[i];
  return { resultVsOrig: rd, dispVsOrig: dd, alphaSum: Math.round(as), fade: fade.value, ready };
};
})();
