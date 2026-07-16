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
let origDisp = null, resultDisp = null, alphaDisp = null, protectDisp = null;
let worker = null, busy = false, ready = false;
let brushOn = false, showProtect = true, holdCompare = false;

function setStatus(t) { status.textContent = t || ""; }
function setOverlay(show, text, pct) {
  overlay.hidden = !show;
  if (text != null) ovtext.textContent = text;
  if (pct != null) { ovbar.hidden = false; ovbar.value = pct; }
  else ovbar.hidden = true;
}

function getWorker() {
  if (!worker) worker = new Worker("js/worker.js?v=11");
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
    el.textContent = `✅ WebGPU 利用可能${name ? " — " + name : ""}（高速処理OK）`;
    el.className = "gpustatus ok";
  } catch (_) {
    el.textContent = "⚠️ WebGPUが使えないため CPU(WASM) で動作します。高品質LaMaは非常に遅くなるので「標準 MI-GAN」推奨";
    el.className = "gpustatus warn";
    // 非対応環境では標準モデルを既定に
    const mg = document.querySelector('input[name=model][value=migan]');
    if (mg) mg.checked = true;
  }
})();

/* ===== ファイル受け付け ===== */
drop.addEventListener("click", () => fileIn.click());
drop.addEventListener("dragover", e => { e.preventDefault(); drop.classList.add("hover"); });
drop.addEventListener("dragleave", () => drop.classList.remove("hover"));
drop.addEventListener("drop", e => {
  e.preventDefault(); drop.classList.remove("hover");
  if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
});
fileIn.addEventListener("change", () => { if (fileIn.files[0]) handleFile(fileIn.files[0]); });

async function handleFile(file) {
  if (busy) return;
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
    setOverlay(true, "準備中…", null);

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
  detail.textContent = totalSec
    ? `合計 ${totalSec.toFixed(1)}s — 検出 ${(s.detMs / 1000).toFixed(1)}s / インペイント ${(s.inMs / 1000).toFixed(1)}s (${s.ep})` +
      (s.bufMs ? ` / 再充填 ${(s.bufMs / 1000).toFixed(1)}s` : "") +
      (s.sweepMs ? ` / スイープ ${(s.sweepMs / 1000).toFixed(1)}s` : "")
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
  resultDisp = null; alphaDisp = null; protectDisp = new Float32Array(dw * dh);
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
      const wgt = beta * alphaDisp[i];
      let r = resultDisp[p]     * (1 - wgt) + origDisp[p]     * wgt;
      let g = resultDisp[p + 1] * (1 - wgt) + origDisp[p + 1] * wgt;
      let b = resultDisp[p + 2] * (1 - wgt) + origDisp[p + 2] * wgt;
      const pv = protectDisp[i];
      if (pv > 0) {
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
  if (!brushOn) { brushCursor.hidden = true; return; }
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
  if (brushOn && protectDisp) {
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
  if (painting && brushOn) { paintAt(ev); ev.preventDefault(); }
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
        if (soft > protectDisp[i]) protectDisp[i] = soft;
      }
    }
  }
  queueRender();
}

$("brushbtn").addEventListener("click", () => {
  brushOn = !brushOn;
  $("brushbtn").classList.toggle("active", brushOn);
  canvas.style.cursor = brushOn ? "none" : "";   // ブラシ中はOSカーソルを消して円を表示
  if (!brushOn) brushCursor.hidden = true;
  $("hint").textContent = brushOn ? "🖌 なぞった場所は変換されません" : "🖐 画像を長押しで元画像と比較";
  if (brushOn && !showProtect) toggleShowProtect();
  queueRender();
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
  $("showprotectbtn").classList.toggle("on", showProtect);
  queueRender();
}
$("showprotectbtn").addEventListener("click", toggleShowProtect);
$("clearprotect").addEventListener("click", () => {
  if (protectDisp) protectDisp.fill(0);
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
  view.hidden = true; setup.hidden = false;
  orig = result = alphaMap = origDisp = resultDisp = alphaDisp = protectDisp = null;
  ready = false;
  brushOn = false;
  $("brushbtn").classList.remove("active");
  canvas.style.cursor = "";
  brushCursor.hidden = true;
  setStatus("");
  fileIn.value = "";
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
