// worker.js — 全処理(検出+保護+推論+スイープ+合成素材)をWorkerで実行
// main threadはUI専任(フリーズしない)
"use strict";

importScripts("../vendor/opencv.js");
importScripts("https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort.webgpu.min.js");
importScripts("detect.js");
importScripts("inpaint.js");
// worker内ではwasmバイナリの相対解決が壊れるためCDNを明示
ort.env.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/";

const cvReady = new Promise(res => {
  if (typeof cv !== "undefined" && cv.Mat) res();
  else cv.onRuntimeInitialized = res;
});

const post = (type, payload, transfer) => self.postMessage({ type, ...payload }, transfer || []);
const progress = (text, pct) => post("progress", { text, pct });

// small スケール cv.Mat(CV_8U) → フル Uint8Array (最近傍)
function upscaleMaskNearest(maskMat, W, H) {
  const mw = maskMat.cols, mh = maskMat.rows, src = maskMat.data;
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const sy = Math.min(mh - 1, (y * mh / H) | 0), ro = sy * mw;
    for (let x = 0; x < W; x++)
      out[y * W + x] = src[ro + Math.min(mw - 1, (x * mw / W) | 0)];
  }
  return out;
}

// small スケール cv.Mat(CV_32F) → フル Float32Array (バイリニア)
function upscaleFloatBilinear(matF, W, H) {
  const mw = matF.cols, mh = matF.rows, src = matF.data32F;
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const fy = y * (mh - 1) / Math.max(1, H - 1);
    const y0 = fy | 0, y1 = Math.min(mh - 1, y0 + 1), wy = fy - y0;
    for (let x = 0; x < W; x++) {
      const fx = x * (mw - 1) / Math.max(1, W - 1);
      const x0 = fx | 0, x1 = Math.min(mw - 1, x0 + 1), wx = fx - x0;
      out[y * W + x] = src[y0 * mw + x0] * (1 - wx) * (1 - wy) + src[y0 * mw + x1] * wx * (1 - wy)
                     + src[y1 * mw + x0] * (1 - wx) * wy + src[y1 * mw + x1] * wx * wy;
    }
  }
  return out;
}

// フル RGBA → small ImageData (box平均)
function downsampleRGBA(rgba, W, H, tw) {
  const th = Math.round(H * tw / W);
  const out = new Uint8ClampedArray(tw * th * 4);
  const bx = W / tw, by = H / th;
  for (let y = 0; y < th; y++) {
    const sy0 = Math.floor(y * by), sy1 = Math.min(H, Math.ceil((y + 1) * by));
    for (let x = 0; x < tw; x++) {
      const sx0 = Math.floor(x * bx), sx1 = Math.min(W, Math.ceil((x + 1) * bx));
      let r = 0, g = 0, b = 0, n = 0;
      for (let sy = sy0; sy < sy1; sy += 2)
        for (let sx = sx0; sx < sx1; sx += 2) {
          const i = (sy * W + sx) * 4;
          r += rgba[i]; g += rgba[i + 1]; b += rgba[i + 2]; n++;
        }
      const o = (y * tw + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
    }
  }
  return new ImageData(out, tw, th);
}

self.onmessage = async (e) => {
  const msg = e.data;
  if (msg.type !== "process") return;
  try {
    await cvReady;
    const { W, H, kirara } = msg;
    const full = new Uint8ClampedArray(msg.full);
    const smallData = new ImageData(new Uint8ClampedArray(msg.small.buf), msg.small.w, msg.small.h);
    const midData = msg.mid ? new ImageData(new Uint8ClampedArray(msg.mid.buf), msg.mid.w, msg.mid.h) : null;

    progress("モデル準備中…", null);
    const ep = await Inpaint.loadModel((t, p) => progress(t, p));

    const t0 = performance.now();
    const { mask, thin, subject } = Detect.detectNet(smallData, midData, {
      kirara, progress: t => progress(t, null),
    });
    thin.delete();
    const detMs = performance.now() - t0;

    const maskData = upscaleMaskNearest(mask, W, H);

    progress("インペイント準備…", null);
    const t1 = performance.now();
    let result = await Inpaint.inpaint(full, maskData, W, H, (t, p) => progress(t, p));
    const inMs = performance.now() - t1;

    // 残骸スイープ: 結果の背景ゾーンに残った点/切れ端を検出して再イン ペイント
    progress("残骸スイープ…", null);
    let sweepMs = 0, sweepCov = 0;
    try {
      const t2 = performance.now();
      const smallRes = downsampleRGBA(result, W, H, mask.cols);
      const sMask = Detect.sweepSpecks(smallRes, subject);
      if (sMask) {
        const sData = upscaleMaskNearest(sMask, W, H);
        let cnt = 0;
        for (let i = 0; i < sData.length; i++) { if (sData[i]) { cnt++; maskData[i] = 255; } }
        sweepCov = 100 * cnt / (W * H);
        if (cnt > 0) {
          result = await Inpaint.inpaint(result, sData, W, H,
            (t, p) => progress("スイープ " + t, p));
        }
        sMask.delete();
      }
      sweepMs = performance.now() - t2;
    } catch (se) { console.warn("sweep skipped:", se); }

    // フェザーα (small blur → バイリニア拡大)
    progress("仕上げ…", null);
    const mFull = cv.matFromArray(mask.rows, mask.cols, cv.CV_8U, upscaleToSmall(maskData, W, H, mask.cols, mask.rows));
    const mF = new cv.Mat();
    mFull.convertTo(mF, cv.CV_32F, 1 / 255.0);
    cv.GaussianBlur(mF, mF, new cv.Size(0, 0), 2);
    const alpha = upscaleFloatBilinear(mF, W, H);
    mFull.delete(); mF.delete(); mask.delete(); subject.delete();

    const resBuf = result.buffer;
    const alphaBuf = alpha.buffer;
    post("done", {
      result: resBuf, alpha: alphaBuf, W, H,
      stats: { detMs, inMs, sweepMs, sweepCov, ep: Inpaint.ep },
    }, [resBuf, alphaBuf]);
  } catch (err) {
    let m = err && err.message;
    if (typeof err === "number" && typeof cv !== "undefined" && cv.exceptionFromPtr) {
      try { m = cv.exceptionFromPtr(err).msg; } catch (_) {}
    }
    post("error", { message: m || String(err) });
  }
};

// フルマスク → smallへ縮小(最近傍) — αフェザー用
function upscaleToSmall(maskData, W, H, mw, mh) {
  const out = new Uint8Array(mw * mh);
  for (let y = 0; y < mh; y++) {
    const sy = Math.min(H - 1, Math.round(y * H / mh));
    for (let x = 0; x < mw; x++) {
      const sx = Math.min(W - 1, Math.round(x * W / mw));
      out[y * mw + x] = maskData[sy * W + sx];
    }
  }
  return out;
}
