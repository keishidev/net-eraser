// worker.js — 全処理(検出+保護+推論+仕上げチェーン)をWorkerで実行
// パイプライン: 検出 → インペイント → 腕/リボンバッファ → 残骸スイープ → 輪郭復元
"use strict";

// worker.js?v=N のクエリを子スクリプトにも伝搬(古いキャッシュ読込を防ぐ)
const __V = new URLSearchParams(self.location.search).get("v") || "0";
importScripts("../vendor/opencv.js");
importScripts("https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/ort.webgpu.min.js");
importScripts(`detect.js?v=${__V}`);
importScripts(`inpaint.js?v=${__V}`);
// worker内ではwasmバイナリの相対解決が壊れるためCDNを明示
ort.env.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/";

const cvReady = new Promise(res => {
  if (typeof cv !== "undefined" && cv.Mat) res();
  else cv.onRuntimeInitialized = res;
});

const post = (type, payload, transfer) => self.postMessage({ type, ...payload }, transfer || []);
const progress = (text, pct) => post("progress", { text, pct });

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

// 消しブラシの追加インペイント(結果画像に対してユーザー指定マスクを消す)
async function handleMore(msg) {
  try {
    await cvReady;
    const { W, H } = msg;
    const cur = new Uint8ClampedArray(msg.result);
    const maskData = new Uint8Array(msg.mask);
    await Inpaint.loadModel(msg.model || "migan", (t, p) => progress(t, p));
    const out = await Inpaint.inpaint(cur, maskData, W, H,
      (t, p) => progress(t, p), "指定された場所を消しています");
    // αデルタ(フェザー付き)
    const sw = 1600, sh = Math.round(H * sw / W);
    const mSmall = cv.matFromArray(sh, sw, cv.CV_8U, maskFullToSmall(maskData, W, H, sw, sh));
    const mF = new cv.Mat();
    mSmall.convertTo(mF, cv.CV_32F, 1 / 255.0);
    cv.GaussianBlur(mF, mF, new cv.Size(0, 0), 2);
    const alpha = upscaleFloatBilinear(mF, W, H);
    mSmall.delete(); mF.delete();
    const ob = out.buffer, ab = alpha.buffer;
    post("moreDone", { result: ob, alpha: ab }, [ob, ab]);
  } catch (err) {
    post("error", { message: (err && err.message) || String(err) });
  }
}

function maskFullToSmall(maskData, W, H, mw, mh) {
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

self.onmessage = async (e) => {
  const msg = e.data;
  if (msg.type === "more") return handleMore(msg);
  if (msg.type !== "process") return;
  try {
    await cvReady;
    const { W, H, kirara, model } = msg;
    const full = new Uint8ClampedArray(msg.full);
    const smallData = new ImageData(new Uint8ClampedArray(msg.small.buf), msg.small.w, msg.small.h);
    const midData = msg.mid ? new ImageData(new Uint8ClampedArray(msg.mid.buf), msg.mid.w, msg.mid.h) : null;

    progress("AIモデルを準備しています…", null);
    await Inpaint.loadModel(model || "migan", (t, p) => progress(t, p));

    const t0 = performance.now();
    const { mask, thin, subject } = Detect.detectNet(smallData, midData, {
      kirara, progress: t => progress(t, null),
    });
    thin.delete();
    const detMs = performance.now() - t0;

    const maskData = upscaleMaskNearest(mask, W, H);

    // 1) メインインペイント
    const t1 = performance.now();
    let result = await Inpaint.inpaint(full, maskData, W, H, (t, p) => progress(t, p));
    const inMs = performance.now() - t1;

    // 2) 腕/リボンバッファ: ピンク領域の紐周辺を広く再充填(溝・影ごと除去)
    let bufMs = 0;
    if (kirara) {
      try {
        const t2 = performance.now();
        progress("腕やリボンを整えています…", null);
        const zone = Detect.pinkZones(smallData);
        const strips = Detect.buildStrips(mask, zone);
        zone.delete();
        if (strips) {
          const sData = upscaleMaskNearest(strips, W, H);
          strips.delete();
          for (let i = 0; i < sData.length; i++) if (sData[i]) maskData[i] = 255;
          result = await Inpaint.inpaint(result, sData, W, H,
            (t, p) => progress(t, p), "腕やリボンを整えています");
        }
        bufMs = performance.now() - t2;
      } catch (be) { console.warn("buffer skipped:", be); }
    }

    // 3) 残骸スイープ(背景の点/切れ端)
    let sweepMs = 0;
    try {
      const t3 = performance.now();
      progress("消し残しを掃除しています…", null);
      const smallRes = downsampleRGBA(result, W, H, mask.cols);
      const sMask = Detect.sweepSpecks(smallRes, subject);
      if (sMask) {
        const sData = upscaleMaskNearest(sMask, W, H);
        sMask.delete();
        let cnt = 0;
        for (let i = 0; i < sData.length; i++) if (sData[i]) { cnt++; maskData[i] = 255; }
        if (cnt > 0) {
          result = await Inpaint.inpaint(result, sData, W, H,
            (t, p) => progress(t, p), "消し残しを掃除しています");
        }
      }
      sweepMs = performance.now() - t3;
    } catch (se) { console.warn("sweep skipped:", se); }

    // 4) 輪郭復元: キャラのシルエット帯は元画像に戻す(紐横断部を除く)
    try {
      progress("輪郭を整えています…", null);
      const wMat = Detect.contourWeights(subject, mask);
      const wFull = upscaleFloatBilinear(wMat, W, H);
      wMat.delete();
      for (let i = 0, p = 0; i < W * H; i++, p += 4) {
        const wv = wFull[i];
        if (wv > 0.003) {
          result[p]     = result[p]     * (1 - wv) + full[p]     * wv;
          result[p + 1] = result[p + 1] * (1 - wv) + full[p + 1] * wv;
          result[p + 2] = result[p + 2] * (1 - wv) + full[p + 2] * wv;
        }
      }
    } catch (ce) { console.warn("contour skipped:", ce); }

    // 5) フェザーα (fade スライダー用)
    progress("最後の仕上げをしています…", null);
    const mSmall = cv.matFromArray(mask.rows, mask.cols, cv.CV_8U,
                                   maskFullToSmall(maskData, W, H, mask.cols, mask.rows));
    const mF = new cv.Mat();
    mSmall.convertTo(mF, cv.CV_32F, 1 / 255.0);
    cv.GaussianBlur(mF, mF, new cv.Size(0, 0), 2);
    const alpha = upscaleFloatBilinear(mF, W, H);
    mSmall.delete(); mF.delete(); mask.delete(); subject.delete();

    const resBuf = result.buffer, alphaBuf = alpha.buffer;
    post("done", {
      result: resBuf, alpha: alphaBuf, W, H,
      stats: { detMs, inMs, bufMs, sweepMs, ep: Inpaint.ep },
    }, [resBuf, alphaBuf]);
  } catch (err) {
    let m = err && err.message;
    if (typeof err === "number" && typeof cv !== "undefined" && cv.exceptionFromPtr) {
      try { m = cv.exceptionFromPtr(err).msg; } catch (_) {}
    }
    post("error", { message: m || String(err) });
  }
};
