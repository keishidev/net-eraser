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
let strokes = [], currentStroke = null;     // ブラシのストローク履歴(Undo用)
let zoom = 1, vpx = 0, vpy = 0;             // 拡大倍率とビューポート左上(フル解像度座標)

function setStatus(t) { status.textContent = t || ""; }
function setOverlay(show, text, pct) {
  overlay.hidden = !show;
  if (text != null) ovtext.textContent = text;
  if (pct != null) { ovbar.hidden = false; ovbar.value = pct; }
  // pct==null のときはバーを隠さず直前の値を維持(単一進捗バー)
}

/* ===== タブタイトル / 処理中ロック ===== */
const BASE_TITLE = document.title;
let titleTimer = null;
function setTitleProgress(pct) {
  document.title = pct != null ? `処理中 ${Math.round(pct)}% | ネット消しゴム` : "処理中… | ネット消しゴム";
}
function restoreTitle() {
  if (titleTimer) { clearTimeout(titleTimer); titleTimer = null; }
  document.title = BASE_TITLE;
}
function markTitleDone() {
  document.title = "✓ 完了 | ネット消しゴム";
  if (titleTimer) clearTimeout(titleTimer);
  titleTimer = setTimeout(restoreTitle, 8000);
  window.addEventListener("pointerdown", restoreTitle, { once: true });
}
function setProcessing(on) {   // 処理中は保存/別の写真/Undoを無効化
  $("download").disabled = on;
  $("reset").disabled = on;
  $("undobtn").disabled = on;
}

function getWorker() {
  if (!worker) worker = new Worker("js/worker.js?v=33");
  return worker;
}

/* ===== 匿名利用統計 (PostHog / config駆動) ===== */
// posthogToken が空なら何もしない(スクリプトも読み込まない)
function initAnalytics() {
  const cfg = window.APP_CONFIG || {};
  if (!cfg.posthogToken) return;
  const host = cfg.posthogHost || "https://us.i.posthog.com";
  const s = document.createElement("script");
  s.src = host.replace("us.i.", "us-assets.i.") + "/static/array.js";
  s.async = true;
  s.onload = () => {
    if (!window.posthog || !window.posthog.init) return;
    window.posthog.init(cfg.posthogToken, {
      api_host: host,
      autocapture: false,
      capture_pageview: true,
      disable_session_recording: true,
      persistence: "localStorage",
      loaded: () => {
        // ボタンのクリック処理は書かない: PostHogサーベイ(widget selector)が拾う
        const b = $("feedbackbtn"); if (b) b.hidden = false;
        const n = $("statsnote"); if (n) n.hidden = false;
      },
    });
  };
  document.head.appendChild(s);
}
window.initAnalytics = initAnalytics;   // トークン注入後の手動検証用
initAnalytics();

// 匿名イベント送信(画像データ・ファイル名は絶対に送らない)
function track(ev, props) {
  try { if (window.posthog && window.posthog.capture) window.posthog.capture(ev, props); } catch (_) {}
}

/* ===== サーバー高画質処理 (config駆動) ===== */
const brokerUrl = () => (window.APP_CONFIG || {}).gpuBrokerUrl || "";
let cloudAlive = false, cloudQueueLen = 0;
let cloudAbort = null;   // 進行中サーバージョブの中止関数
let lastFile = null;     // エラー時「端末内処理でやり直す」用
let lastMode = "kirara"; // 直近handleFileのモード(手直しジョブに使う)

let cloudFails = 0;
async function checkCloudHealth() {
  const base = brokerUrl();
  if (!base) return;
  try {
    const r = await fetch(base + "/api/health", { cache: "no-store" });
    const j = await r.json();
    cloudAlive = !!j.workerAlive;
    cloudQueueLen = j.queueLen | 0;
    cloudFails = 0;
  } catch (_) {
    // 通信の瞬断で選択を勝手に外さない: 2回連続失敗した時だけ停止扱い
    if (++cloudFails < 2) return;
    cloudAlive = false;
  }
  // 既定は: ワーカー稼働中で、ユーザーがまだ仕上がりを一度も選んでいなければ自動選択
  // (プログラム的なchecked変更はchangeイベントを発火しないため保存はされない)
  if (cloudAlive && !localStorage.getItem("sel_model")) {
    const cr = document.querySelector('input[name=model][value=cloud]');
    if (cr && !cr.checked) cr.checked = true;
  }
  updateCloudChip();
}

// チップの表示更新: 停止中でも選択中なら隠さず「停止中」表示(勝手に選択を外さない・DLも始めない)
function updateCloudChip() {
  const chip = $("cloudchip");
  if (!chip) return;
  const sel = document.querySelector('input[name=model][value=cloud]');
  const selected = !!(sel && sel.checked);
  chip.hidden = !cloudAlive && !selected;
  chip.style.opacity = cloudAlive ? "" : ".55";
  const small = chip.querySelector("small");
  if (small) small.textContent = cloudAlive ? "開発者のGPUで最高品質・約40秒" : "停止中 — 復帰をお待ちください";
}
// モード/仕上がりの選択を記憶して復元
// (再読み込みで選択が外れ、気づかず端末内処理+モデルDLになる事故の防止)
(function restoreChoices() {
  const savedMode = localStorage.getItem("sel_mode");
  if (savedMode) {
    const r = document.querySelector(`input[name=mode][value="${savedMode}"]`);
    if (r) r.checked = true;
  }
  const savedModel = localStorage.getItem("sel_model");
  if (savedModel) {
    const r = document.querySelector(`input[name=model][value="${savedModel}"]`);
    if (r && (savedModel !== "cloud" || brokerUrl())) {
      r.checked = true;
      if (savedModel === "cloud") {
        // ヘルス確認前でもチップを出して選択を見せる(状態表示はupdateCloudChipが上書き)
        const chip = $("cloudchip");
        if (chip) {
          chip.hidden = false;
          const small = chip.querySelector("small");
          if (small) small.textContent = "確認中…";
        }
      }
    }
  }
  document.querySelectorAll("input[name=mode], input[name=model]").forEach(el =>
    el.addEventListener("change", () => {
      const mv = document.querySelector("input[name=mode]:checked");
      const kv = document.querySelector("input[name=model]:checked");
      if (mv) localStorage.setItem("sel_mode", mv.value);
      if (kv) localStorage.setItem("sel_model", kv.value);
      updateCloudChip();
    }));
})();

if (brokerUrl()) {
  checkCloudHealth();
  setInterval(() => { if (!setup.hidden) checkCloudHealth(); }, 60000);   // setup表示中のみ60秒毎
}

const authHeaders = () => ({ Authorization: "Bearer " + (window.AUTH_TOKEN || "") });

function uploadCloudJob(base, body, query, label) {
  return new Promise((res, rej) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", base + "/api/job?" + query);
    xhr.setRequestHeader("Authorization", "Bearer " + (window.AUTH_TOKEN || ""));
    xhr.responseType = "json";
    xhr.timeout = 180000;
    xhr.upload.onprogress = e => {
      if (e.lengthComputable) {
        const p = e.loaded / e.total * 100;
        setOverlay(true, `${label}… ${Math.round(p)}%`, p);
        setTitleProgress(p);
      }
    };
    xhr.onload = () => {
      if (xhr.status === 200 && xhr.response && xhr.response.jobId) res(xhr.response.jobId);
      else if (xhr.status === 401) rej(new Error("__auth401__"));
      else if (xhr.status === 429) rej(new Error("__limit429__"));
      else rej(new Error(`送信に失敗しました (HTTP ${xhr.status})`));
    };
    xhr.onerror = () => rej(new Error("サーバーに接続できません"));
    xhr.ontimeout = () => rej(new Error("送信がタイムアウトしました"));
    xhr.onabort = () => rej(new Error("__cancelled__"));
    cloudAbort = () => { try { xhr.abort(); } catch (_) {} };
    xhr.send(body);
  });
}

async function pollCloudJob(base, jobId, procText) {
  const deadline = performance.now() + 180000;   // 3分でタイムアウト
  let cancelled = false, deadPolls = 0;
  cloudAbort = () => { cancelled = true; };
  while (true) {
    await new Promise(r => setTimeout(r, 2000));   // 2秒毎
    if (cancelled) throw new Error("__cancelled__");
    if (performance.now() > deadline) throw new Error("サーバー処理がタイムアウトしました(3分)");
    let j = null;
    try {
      const r = await fetch(`${base}/api/job/${jobId}`, { headers: authHeaders(), cache: "no-store" });
      if (r.status === 401) throw new Error("__auth401__");
      j = await r.json();
    } catch (e) {
      if (e && e.message === "__auth401__") throw e;
      continue;   // 一時的な通信失敗・ワーカー生死に関わらず進行中ジョブはポーリング継続
    }
    if (j.status === "done") return j.stats || {};
    if (j.status === "failed") throw new Error(j.error || "サーバー処理に失敗しました");
    if (j.status === "processing") {
      setOverlay(true, procText || "サーバーのGPUで処理中…(約40秒)", null);   // pct=null: バーは直前値を維持
      setTitleProgress(null);
    } else {   // pending: healthのqueueLenから順番を表示
      try {
        const h = await (await fetch(base + "/api/health", { cache: "no-store" })).json();
        cloudQueueLen = h.queueLen | 0;
        // 順番待ち中にワーカーが落ちたら3分待たせず知らせる(約10秒の猶予)
        if (h.workerAlive === false) { deadPolls++; } else { deadPolls = 0; }
      } catch (_) {}
      if (deadPolls >= 5) throw new Error("サーバーの提供が停止しました。端末内処理をお試しください");
      const ahead = Math.max(0, cloudQueueLen - 1);
      setOverlay(true, `順番待ちです…${ahead > 0 ? `(前に${ahead}件)` : ""}`, null);
      setTitleProgress(null);
    }
  }
}

async function fetchCloudImage(url) {
  const r = await fetch(url, { headers: authHeaders() });
  if (!r.ok) throw new Error(`結果の取得に失敗しました (HTTP ${r.status})`);
  const bmp = await createImageBitmap(await r.blob());
  const c = new OffscreenCanvas(W, H);
  const cx = c.getContext("2d", { willReadFrequently: true });
  cx.drawImage(bmp, 0, 0, W, H);
  bmp.close();
  return cx.getImageData(0, 0, W, H).data;
}

async function processCloud(file, mode, t0) {
  try {
    const base = brokerUrl();
    // 常にcanvasから再エンコードして送信(EXIF回転を確定させる)
    // 元ファイル直送だとスマホ縦写真がサーバー側で横向きのまま処理され、
    // 返却画像の縦横がアプリ側(W,H)と食い違って崩れる
    const c = document.createElement("canvas");
    c.width = W; c.height = H;
    c.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(orig), W, H), 0, 0);
    const blob = await new Promise(res => c.toBlob(res, "image/jpeg", 0.97));
    setOverlay(true, "サーバーへ送信中… 0%", 0);
    const jobId = await uploadCloudJob(base, blob, "mode=" + encodeURIComponent(mode), "サーバーへ送信中");
    const stats = await pollCloudJob(base, jobId);
    setOverlay(true, "結果を受け取っています…", null);
    const resData = await fetchCloudImage(`${base}/api/job/${jobId}/result`);
    const maskData = await fetchCloudImage(`${base}/api/job/${jobId}/mask`);
    result = new Uint8ClampedArray(resData);
    alphaMap = new Float32Array(W * H);
    for (let i = 0, p = 0; i < W * H; i++, p += 4) alphaMap[i] = maskData[p] > 127 ? 1 : 0;
    cloudAbort = null;
    finishReady({
      prepMs: 0, detMs: stats.detect_ms || 0, inMs: stats.inpaint_ms || 0,
      bufMs: 0, sweepMs: 0, finalizeMs: stats.finalize_ms || 0, ep: "cloud",
    }, (performance.now() - t0) / 1000);
  } catch (e) {
    cloudAbort = null;
    if (e && e.message === "__cancelled__") {
      // 中止: サーバー側のジョブは放置でよい(1時間以内に自動削除される)
      setOverlay(false);
      view.hidden = true; setup.hidden = false;
      orig = result = alphaMap = origDisp = resultDisp = alphaDisp = protectDisp = null;
      ready = false; busy = false;
      setProcessing(false);
      restoreTitle();
      fileIn.value = "";
      track("process_cancelled", {});
      setStatus("中止しました");
      return;
    }
    const msg =
      e && e.message === "__auth401__" ? "ログインの有効期限が切れました。再読み込みしてログインし直してください" :
      e && e.message === "__limit429__" ? "本日のサーバー処理の上限に達しました。端末内処理をご利用ください" :
      (e && e.message) || String(e);
    console.error(e);
    track("process_error", { message: ("cloud: " + msg).slice(0, 200) });
    setOverlay(true, "エラー: " + msg, null);
    $("retrylocal").hidden = false;
    setProcessing(false);
    restoreTitle();
    busy = false;
  }
}

// なぞった所を消す をサーバーで実行(multipart: image=現画像JPEG, mask=なぞりPNG 0/255)
async function applyEraseCloud(maskFull) {
  try {
    const base = brokerUrl();
    // 現在のresultをJPEG化
    const rc = document.createElement("canvas");
    rc.width = W; rc.height = H;
    rc.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(result), W, H), 0, 0);
    const imgBlob = await new Promise(res => rc.toBlob(res, "image/jpeg", 0.97));
    // なぞりマスクをPNG化(0/255グレー)
    const mc = document.createElement("canvas");
    mc.width = W; mc.height = H;
    const mctx = mc.getContext("2d");
    const md = mctx.createImageData(W, H);
    for (let i = 0, p = 0; i < W * H; i++, p += 4) {
      const v = maskFull[i];
      md.data[p] = v; md.data[p + 1] = v; md.data[p + 2] = v; md.data[p + 3] = 255;
    }
    mctx.putImageData(md, 0, 0);
    const maskBlob = await new Promise(res => mc.toBlob(res, "image/png"));
    const fd = new FormData();
    fd.append("image", imgBlob, "image.jpg");
    fd.append("mask", maskBlob, "mask.png");
    setOverlay(true, "手直しを送信中… 0%", 0);
    const jobId = await uploadCloudJob(base, fd, `mode=${encodeURIComponent(lastMode)}&type=more`, "手直しを送信中");
    await pollCloudJob(base, jobId, "サーバーで手直し中…(数秒)");
    setOverlay(true, "結果を受け取っています…", null);
    const resData = await fetchCloudImage(`${base}/api/job/${jobId}/result`);
    const maskData = await fetchCloudImage(`${base}/api/job/${jobId}/mask`);
    result = new Uint8ClampedArray(resData);
    for (let i = 0, p = 0; i < W * H; i++, p += 4)
      if (maskData[p] > 127 && alphaMap[i] < 1) alphaMap[i] = 1;   // 置換画素をalphaへmax合成
    cloudAbort = null;
    eraseDisp.fill(0);
    strokes = strokes.filter(s => s.layer !== "erase");   // AIに焼き込み済みのため取り消し不可
    setApplyEnabled(false);
    buildDisplayCache();
    render();
    setOverlay(false);
    $("controlbar").dataset.disabled = "0";
    markTitleDone();
    track("more_applied", { ep: "cloud" });
  } catch (e) {
    cloudAbort = null;
    if (e && e.message === "__cancelled__") {
      // 中止: なぞり内容ごと編集画面を維持(サーバー側ジョブは自動削除される)
      setOverlay(false);
      $("controlbar").dataset.disabled = "0";
      restoreTitle();
    } else {
      console.error(e);
      track("process_error", { message: ("cloud-more: " + ((e && e.message) || e)).slice(0, 200) });
      setOverlay(true, "エラー: " + ((e && e.message) || String(e)), null);
      $("controlbar").dataset.disabled = "0";   // なぞりは残っているのでで再試行できる
      restoreTitle();
    }
  }
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
    el.textContent = `この端末なら高速に処理できます${name ? "（" + name + "）" : ""}`;
    el.className = "gpustatus ok";
  } catch (_) {
    el.textContent = "この端末では処理がゆっくりになります。「スピード優先」がおすすめです";
    el.className = "gpustatus warn";
    // 非対応環境では標準モデルを既定に(ユーザーが選択を保存済みなら尊重して上書きしない)
    if (!localStorage.getItem("sel_model")) {
      const mg = document.querySelector('input[name=model][value=migan]');
      if (mg) mg.checked = true;
    }
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
  lastFile = file;
  $("retrylocal").hidden = true;
  try {
    const mode = document.querySelector("input[name=mode]:checked").value;
    const modelKey = document.querySelector("input[name=model]:checked").value;
    lastMode = mode;
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
    $("flowguide").hidden = true;
    zoom = 1; vpx = 0; vpy = 0; $("zoomchip").hidden = true;
    setup.hidden = true; view.hidden = false;
    $("controlbar").dataset.disabled = "1";
    setProcessing(true);
    buildOrigOnlyDisplay();
    ovbar.value = 0;
    setOverlay(true, "読み込んでいます…", null);

    // 開発用: ?fake=1 で推論スキップ
    if (location.search.includes("fake=1")) {
      result = orig.slice();
      alphaMap = new Float32Array(W * H);
      finishReady({ detMs: 0, inMs: 0, bufMs: 0, sweepMs: 0, ep: "fake" }, 0);
      return;
    }

    // サーバー高画質処理 — 停止中は黙ってローカル処理へ切り替えない
    if (modelKey === "cloud") {
      if (!cloudAlive) await checkCloudHealth();   // その場で再確認
      if (!cloudAlive) {
        setOverlay(true, "サーバーが応答しません。復帰を待つか、端末内処理に切り替えてください", null);
        $("retrylocal").hidden = false;
        setProcessing(false);
        restoreTitle();
        busy = false;
        return;
      }
      if (!localStorage.getItem("cloud_consent_ok")) {
        if (!window.confirm("サーバー処理では、この写真が処理のため一時的にサーバーへ送信され、1時間以内に自動削除されます。続けますか？")) {
          setOverlay(false);
          view.hidden = true; setup.hidden = false;
          ready = false; busy = false;
          setProcessing(false);
          return;
        }
        localStorage.setItem("cloud_consent_ok", "1");
      }
      await processCloud(file, mode, performance.now());
      return;
    }

    const smallData = scaleImageData(img, Math.min(1600, W), null);
    const midData = mode === "kirara" ? scaleImageData(img, null, 2048) : null;

    const wk = getWorker();
    const t0 = performance.now();
    const done = new Promise((res, rej) => {
      wk.onmessage = ev => {
        const m = ev.data;
        if (m.type === "progress") { setOverlay(true, m.text, m.pct); setTitleProgress(m.pct); }
        else if (m.type === "done") res(m);
        else if (m.type === "cancelled") rej(new Error("__cancelled__"));
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
    if (e && e.message === "__cancelled__") {
      // 中止: 開始画面へ戻す
      setOverlay(false);
      view.hidden = true; setup.hidden = false;
      orig = result = alphaMap = origDisp = resultDisp = alphaDisp = protectDisp = null;
      ready = false; busy = false;
      setProcessing(false);
      restoreTitle();
      fileIn.value = "";
      track("process_cancelled", {});
      setStatus("中止しました");
      return;
    }
    console.error(e);
    track("process_error", { message: String(e.message || e).slice(0, 200) });
    setOverlay(true, "エラー: " + (e.message || String(e)), null);
    setProcessing(false);
    restoreTitle();
    busy = false;
  }
}

function finishReady(s, totalSec) {
  buildDisplayCache();
  render();
  setOverlay(false);
  $("controlbar").dataset.disabled = "0";
  ready = true; busy = false;
  setProcessing(false);
  markTitleDone();
  track("process_done", {
    model: (document.querySelector("input[name=model]:checked") || {}).value,
    mode: (document.querySelector("input[name=mode]:checked") || {}).value,
    seconds: +totalSec.toFixed(1), ep: s.ep, mp: Math.round(W * H / 1e6),
  });
  const stageEl = $("stage");
  stageEl.classList.add("done");
  setTimeout(() => stageEl.classList.remove("done"), 900);
  if (!localStorage.getItem("flowguide_done")) $("flowguide").hidden = false;
  const engine = s.ep === "webgpu" ? "GPU" : s.ep === "wasm" ? "CPU" : s.ep === "cloud" ? "サーバー" : s.ep;
  detail.textContent = totalSec
    ? `処理時間 ${totalSec.toFixed(1)}秒（` +
      (s.prepMs > 1000 ? `準備 ${(s.prepMs / 1000).toFixed(1)}s・` : "") +
      `検出 ${(s.detMs / 1000).toFixed(1)}s・ネット消し ${(s.inMs / 1000).toFixed(1)}s` +
      (s.bufMs ? `・整え ${(s.bufMs / 1000).toFixed(1)}s` : "") +
      (s.sweepMs ? `・掃除 ${(s.sweepMs / 1000).toFixed(1)}s` : "") +
      (s.finalizeMs ? `・仕上げ ${(s.finalizeMs / 1000).toFixed(1)}s` : "") +
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
  if (zoom > 1) { renderZoomed(beta, dw, dh); return; }
  const out = new Uint8ClampedArray(resultDisp.length);
  if (holdCompare) out.set(origDisp);
  else {
    for (let i = 0, p = 0; i < dw * dh; i++, p += 4) {
      const a = alphaDisp[i];
      const wgt = beta * a;
      let r = resultDisp[p]     * (1 - wgt) + origDisp[p]     * wgt;
      let g = resultDisp[p + 1] * (1 - wgt) + origDisp[p + 1] * wgt;
      let b = resultDisp[p + 2] * (1 - wgt) + origDisp[p + 2] * wgt;
      if (showMask && a > 0.04) {   // AIが修正した場所
        g = Math.min(255, g + 34 * a);
        b = Math.min(255, b + 95 * a);
      }
      const ev = eraseDisp[i];
      if (ev > 0) {                 // 消し指定(適用前)は緑
        g = Math.min(255, g + 85 * ev);
        r = r * (1 - 0.15 * ev);
      }
      const pv = protectDisp[i];
      if (pv > 0) {                 // 保護(最優先)
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

// zoom>1: フル解像度の orig/result/alphaMap を直接サンプルして描画(拡大してもシャープ)
function renderZoomed(beta, dw, dh) {
  const out = new Uint8ClampedArray(dw * dh * 4);
  const eff = dispScale * zoom;
  for (let y = 0; y < dh; y++) {
    const oy = Math.min(H - 1, Math.max(0, Math.floor(vpy + y / eff)));
    const dyBase = Math.min(dh - 1, Math.round(oy * dispScale)) * dw;
    for (let x = 0; x < dw; x++) {
      const ox = Math.min(W - 1, Math.max(0, Math.floor(vpx + x / eff)));
      const oi = oy * W + ox, op = oi * 4, p = (y * dw + x) * 4;
      if (holdCompare) {
        out[p] = orig[op]; out[p + 1] = orig[op + 1]; out[p + 2] = orig[op + 2]; out[p + 3] = 255;
        continue;
      }
      const a = alphaMap[oi];
      const wgt = beta * a;
      let r = result[op]     * (1 - wgt) + orig[op]     * wgt;
      let g = result[op + 1] * (1 - wgt) + orig[op + 1] * wgt;
      let b = result[op + 2] * (1 - wgt) + orig[op + 2] * wgt;
      if (showMask && a > 0.04) {   // AIが修正した場所
        g = Math.min(255, g + 34 * a);
        b = Math.min(255, b + 95 * a);
      }
      const di = dyBase + Math.min(dw - 1, Math.round(ox * dispScale));
      const ev = eraseDisp[di];
      if (ev > 0) {                 // 消し指定(適用前)は緑
        g = Math.min(255, g + 85 * ev);
        r = r * (1 - 0.15 * ev);
      }
      const pv = protectDisp[di];
      if (pv > 0) {                 // 保護(最優先)
        r = r * (1 - pv) + orig[op]     * pv;
        g = g * (1 - pv) + orig[op + 1] * pv;
        b = b * (1 - pv) + orig[op + 2] * pv;
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

/* ===== ズーム / パン ===== */
function clampViewport() {
  if (zoom <= 1) { zoom = 1; vpx = 0; vpy = 0; return; }
  const eff = dispScale * zoom;
  const maxX = Math.max(0, W - canvas.width / eff);
  const maxY = Math.max(0, H - canvas.height / eff);
  vpx = Math.max(0, Math.min(maxX, vpx));
  vpy = Math.max(0, Math.min(maxY, vpy));
}
function updateZoomChip() {
  const on = zoom > 1.01;
  $("zoomchip").hidden = !on;
  if (on) $("zoomval").textContent = zoom.toFixed(1) + "x";
}
function setZoomAt(nz, cx, cy) {   // cx,cy: canvas px 上のアンカー
  nz = Math.min(8, Math.max(1, nz));
  const effOld = dispScale * zoom, effNew = dispScale * nz;
  vpx += cx / effOld - cx / effNew;
  vpy += cy / effOld - cy / effNew;
  zoom = nz;
  clampViewport();
  updateZoomChip();
  queueRender();
}
function resetZoom() { zoom = 1; vpx = 0; vpy = 0; updateZoomChip(); queueRender(); }
$("zoomreset").addEventListener("click", resetZoom);

canvas.addEventListener("wheel", ev => {
  if (!ready) return;
  ev.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const cx = (ev.clientX - rect.left) * canvas.width / rect.width;
  const cy = (ev.clientY - rect.top) * canvas.height / rect.height;
  setZoomAt(zoom * Math.exp(-ev.deltaY * 0.002), cx, cy);
}, { passive: false });

canvas.addEventListener("dblclick", ev => {
  if (!ready) return;
  ev.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const cx = (ev.clientX - rect.left) * canvas.width / rect.width;
  const cy = (ev.clientY - rect.top) * canvas.height / rect.height;
  setZoomAt(zoom > 1.01 ? 1 : 3, cx, cy);
});

/* ===== 長押しで元画像比較 / 保護ブラシ / パン ===== */
let painting = false;
let panning = false, panLast = null;        // ドラッグパン
const activePointers = new Map();           // pointerId -> {x,y} (ピンチ判定用)
let pinch = null;                           // 2本指ジェスチャー状態 {dist,cx,cy}
const brushCursor = $("brushcursor");

function pinchState() {
  const pts = [...activePointers.values()];
  const dx = pts[0].x - pts[1].x, dy = pts[0].y - pts[1].y;
  return { dist: Math.hypot(dx, dy) || 1, cx: (pts[0].x + pts[1].x) / 2, cy: (pts[0].y + pts[1].y) / 2 };
}
function doPinch() {
  const now = pinchState();
  const rect = canvas.getBoundingClientRect();
  const kx = canvas.width / rect.width, ky = canvas.height / rect.height;
  setZoomAt(zoom * now.dist / pinch.dist, (now.cx - rect.left) * kx, (now.cy - rect.top) * ky);
  const eff = dispScale * zoom;
  vpx -= (now.cx - pinch.cx) * kx / eff;
  vpy -= (now.cy - pinch.cy) * ky / eff;
  clampViewport();
  queueRender();
  pinch = now;
}

function updateBrushCursor(ev) {
  if (brushMode === "none") { brushCursor.hidden = true; return; }
  brushCursor.style.borderColor = brushMode === "erase" ? "#7fe08f" : "#ff8aa0";
  const stage = $("stage").getBoundingClientRect();
  const rect = canvas.getBoundingClientRect();
  // 表示上のブラシ直径 = ブラシサイズ(canvas px) x 表示スケール
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
canvas.addEventListener("contextmenu", ev => ev.preventDefault());   // 長押し/右クリックのOSメニュー抑止(比較・ブラシ優先)
canvas.addEventListener("pointerdown", ev => {
  if (!ready) return;
  activePointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
  // 2本目のタッチ → ピンチ/パンジェスチャーへ移行(描画・比較は中断)
  if (activePointers.size === 2) {
    if (currentStroke) {
      if (currentStroke.points.length) strokes.push(currentStroke);
      currentStroke = null;
    }
    painting = false; panning = false; panLast = null;
    if (holdCompare) { holdCompare = false; queueRender(); }
    pinch = pinchState();
    try { canvas.setPointerCapture(ev.pointerId); } catch (_) {}
    ev.preventDefault();
    return;
  }
  if (ev.button === 1) {   // 中ボタンドラッグは全ツールでパン
    panning = true; panLast = { x: ev.clientX, y: ev.clientY };
    try { canvas.setPointerCapture(ev.pointerId); } catch (_) {}
    ev.preventDefault();
    return;
  }
  if (brushMode !== "none" && protectDisp) {
    painting = true;
    try { canvas.setPointerCapture(ev.pointerId); } catch (_) {}
    if (currentStroke && currentStroke.points.length) strokes.push(currentStroke);  // 保険: 未確定分を確定
    currentStroke = { layer: brushMode, points: [] };
    paintAt(ev);
  } else {
    holdCompare = true;   // 長押し比較(拡大中はドラッグでパンも)
    if (zoom > 1) { panning = true; panLast = { x: ev.clientX, y: ev.clientY }; }
    try { canvas.setPointerCapture(ev.pointerId); } catch (_) {}
    $("hint").textContent = "元画像を表示中(離すと戻る)";
    queueRender();
  }
  ev.preventDefault();
});
canvas.addEventListener("pointermove", ev => {
  if (activePointers.has(ev.pointerId)) activePointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
  if (pinch && activePointers.size >= 2) { doPinch(); ev.preventDefault(); return; }
  updateBrushCursor(ev);
  if (panning && panLast) {
    const rect = canvas.getBoundingClientRect();
    const eff = dispScale * zoom;
    vpx -= (ev.clientX - panLast.x) * (canvas.width / rect.width) / eff;
    vpy -= (ev.clientY - panLast.y) * (canvas.height / rect.height) / eff;
    panLast = { x: ev.clientX, y: ev.clientY };
    clampViewport();
    queueRender();
    ev.preventDefault();
    return;
  }
  if (painting && brushMode !== "none") { paintAt(ev); ev.preventDefault(); }
});
canvas.addEventListener("pointerenter", updateBrushCursor);
canvas.addEventListener("pointerout", () => { brushCursor.hidden = true; });
function endPointer(ev) {
  if (ev && ev.pointerId != null) activePointers.delete(ev.pointerId);
  if (pinch && activePointers.size < 2) pinch = null;   // ジェスチャー終了(そのまま何もしない)
  if (activePointers.size === 0) { panning = false; panLast = null; }
  if (currentStroke) {
    if (currentStroke.points.length) strokes.push(currentStroke);
    currentStroke = null;
  }
  painting = false;
  if (holdCompare) {
    holdCompare = false;
    $("hint").textContent = "画像を長押しで元画像と比較／ホイールで拡大";
    queueRender();
  }
}
canvas.addEventListener("pointerup", endPointer);
canvas.addEventListener("pointercancel", endPointer);
canvas.addEventListener("pointerleave", () => { if (holdCompare) endPointer(); });

// 1スタンプ分をレイヤーへ塗る(paintAt/Undo再生で共用)
function stampAt(layer, cx, cy, r) {
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
}

function paintAt(ev) {
  const layer = brushMode === "erase" ? eraseDisp : protectDisp;
  if (!layer) return;
  const rect = canvas.getBoundingClientRect();
  // canvas px → 元画像座標(vp+/eff) → disp座標。zoom=1では従来と同値
  const eff = dispScale * zoom;
  const cx = (vpx + (ev.clientX - rect.left) * canvas.width / rect.width / eff) * dispScale;
  const cy = (vpy + (ev.clientY - rect.top) * canvas.height / rect.height / eff) * dispScale;
  const r = (+$("brushsize").value) / 2 / zoom;   // 画面上のブラシ見た目サイズは一定
  stampAt(layer, cx, cy, r);
  if (currentStroke) currentStroke.points.push({ cx, cy, r });
  if (brushMode === "erase") setApplyEnabled(true);
  queueRender();
}

// 直前のひと塗りを取り消し、残りのストロークを再生
function undoStroke() {
  if (!strokes.length) return;
  strokes.pop();
  protectDisp && protectDisp.fill(0);
  eraseDisp && eraseDisp.fill(0);
  for (const s of strokes) {
    const layer = s.layer === "erase" ? eraseDisp : protectDisp;
    if (!layer) continue;
    for (const p of s.points) stampAt(layer, p.cx, p.cy, p.r);
  }
  setApplyEnabled(strokes.some(s => s.layer === "erase"));
  queueRender();
}

// ボタンの有効/無効とtitleをまとめて切替
function setApplyEnabled(on) {
  const b = $("applyerase");
  b.disabled = !on;
  b.title = on ? "緑でなぞった場所をAIで消します" : "先に消しツールで場所をなぞってください";
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
    brushMode === "protect" ? "なぞった場所は変換されません(赤)" :
    brushMode === "erase"   ? "なぞった場所も消します(緑) → 適用" :
    "画像を押している間、元の写真が見えます／ホイールで拡大";
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
  setProcessing(true);
  // モード選択中でワーカー生存なら手直しもサーバー実行(直前にヘルス再確認)
  const modelSel = document.querySelector("input[name=model]:checked").value;
  let useCloud = false;
  if (modelSel === "cloud") {
    setOverlay(true, "サーバーを確認しています…", null);
    await checkCloudHealth();
    useCloud = cloudAlive;
    if (!useCloud) {
      // 停止中: 黙ってローカルへフォールバックせず、明示的に確認する
      if (!window.confirm("サーバーが停止中です。端末内の軽量モデル(約27MBのダウンロード)で手直ししますか？")) {
        setOverlay(false);
        $("controlbar").dataset.disabled = "0";
        busy = false;
        setProcessing(false);
        return;   // なぞりは維持
      }
    }
  }
  if (useCloud) {
    await applyEraseCloud(maskFull);
    busy = false;
    setProcessing(false);
    return;
  }
  setOverlay(true, "指定された場所を消しています…", null);
  try {
    const wk = getWorker();
    const done = new Promise((res, rej) => {
      wk.onmessage = ev => {
        const m = ev.data;
        if (m.type === "progress") { setOverlay(true, m.text, m.pct); setTitleProgress(m.pct); }
        else if (m.type === "moreDone") res(m);
        else if (m.type === "cancelled") rej(new Error("__cancelled__"));
        else if (m.type === "error") rej(new Error(m.message));
      };
      wk.onerror = ev => rej(new Error(ev.message || "worker error"));
    });
    const resBuf = result.slice().buffer;   // コピーを転送(手元は保持)
    const mBuf = maskFull.buffer;
    const mkey = modelSel === "cloud" ? "migan" : modelSel;   // モードのローカルフォールバックは軽量モデル(27MB)で行う
    wk.postMessage({
      type: "more", W, H,
      model: mkey,
      result: resBuf, mask: mBuf,
    }, [resBuf, mBuf]);
    const m = await done;
    result = new Uint8ClampedArray(m.result);
    const alphaDelta = new Float32Array(m.alpha);
    for (let i = 0; i < alphaMap.length; i++)
      if (alphaDelta[i] > alphaMap[i]) alphaMap[i] = alphaDelta[i];
    eraseDisp.fill(0);
    strokes = strokes.filter(s => s.layer !== "erase");   // AIに焼き込み済みのため取り消し不可
    setApplyEnabled(false);
    buildDisplayCache();
    render();
    setOverlay(false);
    $("controlbar").dataset.disabled = "0";
    markTitleDone();
    track("more_applied", {});
  } catch (e) {
    if (e && e.message === "__cancelled__") {
      // moreの中止: 適用前の状態のまま編集画面を維持
      setOverlay(false);
      $("controlbar").dataset.disabled = "0";
      restoreTitle();
    } else {
      console.error(e);
      setOverlay(true, "エラー: " + (e.message || String(e)), null);
      restoreTitle();
    }
  }
  busy = false;
  setProcessing(false);
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
    ? "青 = AIが修正した場所 ／ 赤 = 保護した場所"
    : (brushMode !== "none" ? "ブラシでなぞってください" : "画像を押している間、元の写真が見えます");
  queueRender();
});
$("clearprotect").addEventListener("click", () => {
  // 選択中ブラシのレイヤーを消す(未選択なら両方)。対象ストローク履歴も除去
  if (brushMode === "erase") {
    eraseDisp && eraseDisp.fill(0);
    strokes = strokes.filter(s => s.layer !== "erase");
    setApplyEnabled(false);
  } else if (brushMode === "protect") {
    protectDisp && protectDisp.fill(0);
    strokes = strokes.filter(s => s.layer !== "protect");
  } else {
    protectDisp && protectDisp.fill(0);
    eraseDisp && eraseDisp.fill(0);
    strokes = [];
    setApplyEnabled(false);
  }
  queueRender();
});

/* ===== ストローク単位Undo ===== */
$("undobtn").addEventListener("click", undoStroke);
window.addEventListener("keydown", e => {
  if ((e.ctrlKey || e.metaKey) && e.key === "z" && ready) { e.preventDefault(); undoStroke(); }
});

/* ===== 保存 / リセット ===== */
$("download").addEventListener("click", () => {
  if (!ready) return;
  track("save", { fade: +fade.value });
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
  c.toBlob(async b => {
    const name = `net_removed_${fade.value}pct.jpg`;
    // スマホは共有シート経由で「画像を保存」→写真アプリへ入れられる
    // (デスクトップは従来どおり即ダウンロード)
    const isTouch = window.matchMedia("(pointer: coarse)").matches;
    if (isTouch && navigator.canShare) {
      const file = new File([b], name, { type: "image/jpeg" });
      if (navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: "ネット消しゴム" });
          setOverlay(false);
          return;                                  // 共有シートで保存完了
        } catch (e) {
          if (e && e.name === "AbortError") { setOverlay(false); return; }  // ユーザーが閉じた
          // 不許可等 → ダウンロードにフォールバック
        }
      }
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(b);
    a.download = name;
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
  strokes = []; currentStroke = null;
  $("brushbtn").classList.remove("pressed");
  $("erasebtn").classList.remove("pressed");
  $("viewtool").classList.add("pressed");
  $("brushbtn").setAttribute("aria-pressed", "false");
  $("erasebtn").setAttribute("aria-pressed", "false");
  $("viewtool").setAttribute("aria-pressed", "true");
  $("brushsize").disabled = true;
  setApplyEnabled(false);
  zoom = 1; vpx = 0; vpy = 0; $("zoomchip").hidden = true;
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

/* ===== 処理の中止 ===== */
$("cancelbtn").addEventListener("click", () => {
  if (cloudAbort) { cloudAbort(); return; }   // ジョブはローカルで打ち切る(サーバー側は自動削除)
  if (worker) worker.postMessage({ type: "cancel" });
});

/* ===== エラー時: 端末内処理でやり直す ===== */
$("retrylocal").addEventListener("click", () => {
  $("retrylocal").hidden = true;
  const lama = document.querySelector('input[name=model][value=lama]');
  if (lama) lama.checked = true;
  if (lastFile) { busy = false; handleFile(lastFile); }
});

/* デバッグ用フック */
window.__dbg = () => {
  const n = 200000;
  let rd = 0, dd = 0, as = 0;
  if (result && orig) for (let i = 0; i < n; i++) rd += Math.abs(result[i] - orig[i]);
  if (resultDisp && origDisp) for (let i = 0; i < n; i++) dd += Math.abs(resultDisp[i] - origDisp[i]);
  if (alphaMap) for (let i = 0; i < n; i++) as += alphaMap[i];
  return { resultVsOrig: rd, dispVsOrig: dd, alphaSum: Math.round(as), fade: fade.value, ready, zoom, vpx, vpy };
};
})();
