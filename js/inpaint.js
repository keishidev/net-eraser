// inpaint.js — ONNX インペイント (MI-GAN / LaMa) を 512タイルで実行
// マスク画素のみフル解像度に合成する
"use strict";

const Inpaint = (() => {

const TILE = 512, STRIDE = 448; // 64px オーバーラップ

const MODELS = {
  migan: {
    label: "MI-GAN",
    urls: [
      "models/migan_pipeline_v2.onnx",
      "https://huggingface.co/andraniksargsyan/migan/resolve/main/migan_pipeline_v2.onnx",
    ],
  },
  lama: {
    label: "LaMa",
    urls: [
      "models/lama_fp32.onnx",
      "https://huggingface.co/Carve/LaMa-ONNX/resolve/main/lama_fp32.onnx",
    ],
  },
};

const sessions = {};   // key -> {session, ep}
let activeKey = "migan";

async function fetchModel(urls, onProgress) {
  let lastErr = null;
  for (const url of urls) {
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
        if (total) onProgress(`AIモデルをダウンロード中… ${(got / 1048576).toFixed(0)} / ${(total / 1048576).toFixed(0)} MB (初回のみ)`, got / total * 100);
      }
      const buf = new Uint8Array(got);
      let o = 0; for (const c of chunks) { buf.set(c, o); o += c.length; }
      return buf;
    } catch (e) { lastErr = e; }
  }
  throw new Error("モデルの取得に失敗: " + lastErr);
}

async function loadModel(key, onProgress) {
  activeKey = key = key || "migan";
  if (sessions[key]) return sessions[key].ep;
  const buf = await fetchModel(MODELS[key].urls, onProgress);
  onProgress(`${MODELS[key].label} を起動しています…（初回は数十秒かかります）`, null);
  let session = null, ep = "";
  for (const e of ["webgpu", "wasm"]) {
    try {
      session = await ort.InferenceSession.create(buf, {
        executionProviders: [e], graphOptimizationLevel: "all",
      });
      ep = e; break;
    } catch (err) { console.warn("EP create failed:", e, err); }
  }
  if (!session) throw new Error("セッション作成に失敗");
  sessions[key] = { session, ep };
  return ep;
}

async function runSafe(feeds, onProgress) {
  const s = sessions[activeKey];
  try {
    return await s.session.run(feeds);
  } catch (e) {
    if (s.ep === "webgpu") {
      console.warn("WebGPU実行失敗 → WASMへ", e);
      onProgress && onProgress("WebGPU失敗 → CPU(WASM)で続行…", null);
      s.session = await ort.InferenceSession.create(
        await fetchModel(MODELS[activeKey].urls, onProgress || (() => {})),
        { executionProviders: ["wasm"] });
      s.ep = "wasm";
      return await s.session.run(feeds);
    }
    throw e;
  }
}

function planTiles(maskData, W, H) {
  const tiles = [];
  for (let y = 0; ; y += STRIDE) {
    let ty = Math.min(y, Math.max(0, H - TILE));
    for (let x = 0; ; x += STRIDE) {
      let tx = Math.min(x, Math.max(0, W - TILE));
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

// rgba(フル) + maskData(フル 0/255) → マスク画素のみ置換したRGBAを返す
async function inpaint(rgba, maskData, W, H, onProgress, tag) {
  const tiles = planTiles(maskData, W, H);
  if (!tiles.length) return rgba.slice();
  const accR = new Float32Array(W * H), accG = new Float32Array(W * H),
        accB = new Float32Array(W * H), accW = new Float32Array(W * H);
  const isLama = activeKey === "lama";
  const imgU8 = isLama ? null : new Uint8Array(3 * TILE * TILE);
  const mskU8 = isLama ? null : new Uint8Array(TILE * TILE);
  const imgF = isLama ? new Float32Array(3 * TILE * TILE) : null;
  const mskF = isLama ? new Float32Array(TILE * TILE) : null;
  const label = tag || "ネットを消しています";

  for (let ti = 0; ti < tiles.length; ti++) {
    const [tx, ty] = tiles[ti];
    onProgress(`${label}… (${ti + 1}/${tiles.length})`, (ti / tiles.length) * 100);
    for (let y = 0; y < TILE; y++) {
      const sy = Math.min(H - 1, ty + y);
      for (let x = 0; x < TILE; x++) {
        const sx = Math.min(W - 1, tx + x);
        const si = (sy * W + sx) * 4, di = y * TILE + x;
        const hole = maskData[sy * W + sx] ? 1 : 0;
        if (isLama) {
          imgF[di] = rgba[si] / 255;
          imgF[TILE * TILE + di] = rgba[si + 1] / 255;
          imgF[2 * TILE * TILE + di] = rgba[si + 2] / 255;
          mskF[di] = hole;                     // LaMa: 穴=1
        } else {
          imgU8[di] = rgba[si];
          imgU8[TILE * TILE + di] = rgba[si + 1];
          imgU8[2 * TILE * TILE + di] = rgba[si + 2];
          mskU8[di] = hole ? 0 : 255;          // MIGAN: 穴=0
        }
      }
    }
    const feeds = isLama ? {
      image: new ort.Tensor("float32", imgF, [1, 3, TILE, TILE]),
      mask: new ort.Tensor("float32", mskF, [1, 1, TILE, TILE]),
    } : {
      image: new ort.Tensor("uint8", imgU8, [1, 3, TILE, TILE]),
      mask: new ort.Tensor("uint8", mskU8, [1, 1, TILE, TILE]),
    };
    const out = await runSafe(feeds, onProgress);
    const o = out[Object.keys(out)[0]].data;   // LaMa: float 0..255 / MIGAN: uint8
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
    await new Promise(r => setTimeout(r, 0));
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

return { loadModel, inpaint, get ep() { return (sessions[activeKey] || {}).ep || ""; } };
})();
