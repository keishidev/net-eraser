// app.js — UI専任 (処理はすべて js/worker.js 内で実行 → フリーズしない)
"use strict";

(() => {
const $ = id => document.getElementById(id);
const drop = $("drop"), fileIn = $("file"), status = $("status"), prog = $("prog");
const view = $("view"), setup = $("setup"), canvas = $("canvas"), detail = $("detail");
const fade = $("fade"), fadeval = $("fadeval");

let orig = null;       // Uint8ClampedArray RGBA フル
let result = null;     // 除去後 RGBA
let alphaMap = null;   // Float32Array 0..1
let W = 0, H = 0;
let dispScale = 1;
let origDisp = null, resultDisp = null, alphaDisp = null;
let worker = null;
let busy = false;

function setStatus(t, pct) {
  status.textContent = t;
  if (pct != null) { prog.hidden = false; prog.value = pct; } else prog.hidden = true;
}

function getWorker() {
  if (!worker) {
    worker = new Worker("js/worker.js");
  }
  return worker;
}

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
  busy = true;
  try {
    const mode = document.querySelector("input[name=mode]:checked").value;
    const img = await loadImage(file);
    W = img.width; H = img.height;
    setStatus(`読み込み完了 ${W}x${H}。処理を開始…`);

    const c = document.createElement("canvas");
    c.width = W; c.height = H;
    const cx = c.getContext("2d", { willReadFrequently: true });
    cx.drawImage(img, 0, 0);
    const fullData = cx.getImageData(0, 0, W, H);
    orig = fullData.data.slice();               // 手元に保持(転送前にコピー)

    const smallData = scaleImageData(img, Math.min(1600, W), null);
    const midData = mode === "kirara" ? scaleImageData(img, null, 2048) : null;

    const wk = getWorker();
    const t0 = performance.now();
    const done = new Promise((res, rej) => {
      wk.onmessage = ev => {
        const m = ev.data;
        if (m.type === "progress") setStatus(m.text, m.pct);
        else if (m.type === "done") res(m);
        else if (m.type === "error") rej(new Error(m.message));
      };
      wk.onerror = ev => rej(new Error(ev.message || "worker error"));
    });
    const fullBuf = fullData.data.buffer;
    wk.postMessage({
      type: "process", W, H, kirara: mode === "kirara",
      full: fullBuf,
      small: { buf: smallData.data.buffer, w: smallData.width, h: smallData.height },
      mid: midData ? { buf: midData.data.buffer, w: midData.width, h: midData.height } : null,
    }, [fullBuf, smallData.data.buffer].concat(midData ? [midData.data.buffer] : []));

    const m = await done;
    result = new Uint8ClampedArray(m.result);
    alphaMap = new Float32Array(m.alpha);
    const total = ((performance.now() - t0) / 1000).toFixed(1);

    buildDisplayCache();
    setup.hidden = true; view.hidden = false;
    render();
    setStatus("");
    const s = m.stats;
    detail.textContent =
      `合計 ${total}s — 検出 ${(s.detMs / 1000).toFixed(1)}s / インペイント ${(s.inMs / 1000).toFixed(1)}s (${s.ep})` +
      (s.sweepMs ? ` / スイープ ${(s.sweepMs / 1000).toFixed(1)}s` : "");
  } catch (e) {
    console.error(e);
    setStatus("エラー: " + (e.message || String(e)));
  } finally {
    busy = false;
  }
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

// ===== 表示・フェード =====
function buildDisplayCache() {
  dispScale = Math.min(1, 1600 / W);
  const dw = Math.round(W * dispScale), dh = Math.round(H * dispScale);
  canvas.width = dw; canvas.height = dh;
  origDisp = scaleRGBA(orig, W, H, dw, dh);
  resultDisp = scaleRGBA(result, W, H, dw, dh);
  alphaDisp = scaleAlpha(alphaMap, W, H, dw, dh);
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
  const beta = (+fade.value) / 100;
  fadeval.textContent = fade.value + "%";
  const dw = canvas.width, dh = canvas.height;
  const out = new Uint8ClampedArray(resultDisp.length);
  if ($("showorig").checked) out.set(origDisp);
  else {
    for (let i = 0, p = 0; i < dw * dh; i++, p += 4) {
      const wgt = beta * alphaDisp[i];
      out[p]     = resultDisp[p]     * (1 - wgt) + origDisp[p]     * wgt;
      out[p + 1] = resultDisp[p + 1] * (1 - wgt) + origDisp[p + 1] * wgt;
      out[p + 2] = resultDisp[p + 2] * (1 - wgt) + origDisp[p + 2] * wgt;
      out[p + 3] = 255;
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
$("showorig").addEventListener("change", queueRender);

$("download").addEventListener("click", () => {
  const beta = (+fade.value) / 100;
  const out = new Uint8ClampedArray(result.length);
  for (let i = 0, p = 0; i < W * H; i++, p += 4) {
    const wgt = beta * alphaMap[i];
    out[p]     = result[p]     * (1 - wgt) + orig[p]     * wgt;
    out[p + 1] = result[p + 1] * (1 - wgt) + orig[p + 1] * wgt;
    out[p + 2] = result[p + 2] * (1 - wgt) + orig[p + 2] * wgt;
    out[p + 3] = 255;
  }
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  c.getContext("2d").putImageData(new ImageData(out, W, H), 0, 0);
  c.toBlob(b => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(b);
    a.download = `net_removed_${fade.value}pct.jpg`;
    a.click();
  }, "image/jpeg", 0.95);
});

$("reset").addEventListener("click", () => {
  view.hidden = true; setup.hidden = false;
  orig = result = alphaMap = origDisp = resultDisp = alphaDisp = null;
  setStatus("別の写真をどうぞ");
});
})();
