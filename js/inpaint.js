// inpaint.js — LaMa ONNX (512固定) を onnxruntime-web(WebGPU) でタイル実行し、
// マスク画素のみフル解像度に合成する
"use strict";

const Inpaint = (() => {

const TILE = 512, STRIDE = 448; // 64px オーバーラップ

const MODEL_URLS = [
  "models/migan_pipeline_v2.onnx",  // ローカル開発用
  "https://huggingface.co/andraniksargsyan/migan/resolve/main/migan_pipeline_v2.onnx",
];

let session = null;
let epUsed = "";
let modelBuf = null;

async function loadModel(onProgress) {
  if (session) return epUsed;
  let buf = null, lastErr = null;
  for (const url of MODEL_URLS) {
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const total = +resp.headers.get("Content-Length") || 0;
      const reader = resp.body.getReader();
      const chunks = []; let got = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value); got += value.length;
        if (total) onProgress(`モデルDL中 ${(got / 1048576).toFixed(0)}/${(total / 1048576).toFixed(0)} MB`, got / total * 100);
      }
      buf = new Uint8Array(got);
      let o = 0; for (const c of chunks) { buf.set(c, o); o += c.length; }
      break;
    } catch (e) { lastErr = e; }
  }
  if (!buf) throw new Error("モデルの取得に失敗: " + lastErr);
  modelBuf = buf;
  onProgress("推論セッション初期化中…", 100);
  await createSession("webgpu");
  return epUsed;
}

async function createSession(ep) {
  session = await ort.InferenceSession.create(modelBuf, {
    executionProviders: ep === "webgpu" ? ["webgpu"] : ["wasm"],
    graphOptimizationLevel: "all",
  });
  epUsed = ep;
}

// 実行(初回失敗時は wasm に切替えて再試行)
async function runSafe(feeds, onProgress) {
  try {
    return await session.run(feeds);
  } catch (e) {
    if (epUsed === "webgpu") {
      console.warn("WebGPU実行失敗 → WASMへフォールバック", e);
      onProgress && onProgress("WebGPU非対応の演算を検出 → CPU(WASM)で続行…", null);
      await createSession("wasm");
      return await session.run(feeds);
    }
    throw e;
  }
}

// タイル一覧: マスクが載っている 512 窓のみ
function planTiles(maskData, W, H) {
  const tiles = [];
  for (let y = 0; ; y += STRIDE) {
    let ty = Math.min(y, Math.max(0, H - TILE));
    for (let x = 0; ; x += STRIDE) {
      let tx = Math.min(x, Math.max(0, W - TILE));
      // マスク有無チェック(粗く)
      let has = false;
      for (let yy = ty; yy < Math.min(ty + TILE, H) && !has; yy += 4)
        for (let xx = tx; xx < Math.min(tx + TILE, W); xx += 4)
          if (maskData[yy * W + xx]) { has = true; break; }
      if (has) tiles.push([tx, ty]);
      if (tx >= W - TILE || W <= TILE) break;
    }
    if (ty >= H - TILE || H <= TILE) break;
  }
  return tiles;
}

// コサイン窓(タイル継ぎ目のブレンド)
const winCache = (() => {
  const w = new Float32Array(TILE * TILE);
  for (let y = 0; y < TILE; y++) {
    const wy = 0.5 - 0.5 * Math.cos(2 * Math.PI * (y + 0.5) / TILE);
    for (let x = 0; x < TILE; x++) {
      const wx = 0.5 - 0.5 * Math.cos(2 * Math.PI * (x + 0.5) / TILE);
      w[y * TILE + x] = Math.max(1e-4, wx * wy);
    }
  }
  return w;
})();

// rgba: Uint8ClampedArray(フル), mask: Uint8Array(フル 0/255)
// 返り値: result RGBA (マスク部のみ置換済み)
async function inpaint(rgba, maskData, W, H, onProgress) {
  const tiles = planTiles(maskData, W, H);
  if (!tiles.length) return rgba.slice();
  const accR = new Float32Array(W * H), accG = new Float32Array(W * H),
        accB = new Float32Array(W * H), accW = new Float32Array(W * H);

  const imgT = new Uint8Array(3 * TILE * TILE);
  const mskT = new Uint8Array(TILE * TILE);

  for (let ti = 0; ti < tiles.length; ti++) {
    const [tx, ty] = tiles[ti];
    onProgress(`インペイント ${ti + 1}/${tiles.length} タイル…`, (ti / tiles.length) * 100);
    // 準備 (MIGAN pipeline_v2: uint8 RGB 0-255, マスクは穴=0/その他255)
    for (let y = 0; y < TILE; y++) {
      const sy = Math.min(H - 1, ty + y);
      for (let x = 0; x < TILE; x++) {
        const sx = Math.min(W - 1, tx + x);
        const si = (sy * W + sx) * 4, di = y * TILE + x;
        imgT[di] = rgba[si];
        imgT[TILE * TILE + di] = rgba[si + 1];
        imgT[2 * TILE * TILE + di] = rgba[si + 2];
        mskT[di] = maskData[sy * W + sx] ? 0 : 255;
      }
    }
    const out = await runSafe({
      image: new ort.Tensor("uint8", imgT, [1, 3, TILE, TILE]),
      mask: new ort.Tensor("uint8", mskT, [1, 1, TILE, TILE]),
    }, onProgress);
    const o = out[Object.keys(out)[0]].data; // [1,3,512,512] uint8 RGB
    for (let y = 0; y < TILE; y++) {
      const sy = ty + y; if (sy >= H) break;
      for (let x = 0; x < TILE; x++) {
        const sx = tx + x; if (sx >= W) break;
        const gi = sy * W + sx;
        if (!maskData[gi]) continue;
        const di = y * TILE + x, wv = winCache[di];
        accR[gi] += o[di] * wv;
        accG[gi] += o[TILE * TILE + di] * wv;
        accB[gi] += o[2 * TILE * TILE + di] * wv;
        accW[gi] += wv;
      }
    }
    await new Promise(r => setTimeout(r, 0)); // UI息継ぎ
  }
  const res = rgba.slice();
  for (let gi = 0; gi < W * H; gi++) {
    if (accW[gi] > 0) {
      const ri = gi * 4, wv = accW[gi];
      res[ri] = Math.max(0, Math.min(255, accR[gi] / wv));
      res[ri + 1] = Math.max(0, Math.min(255, accG[gi] / wv));
      res[ri + 2] = Math.max(0, Math.min(255, accB[gi] / wv));
    }
  }
  return res;
}

return { loadModel, inpaint, get ep() { return epUsed; } };
})();
