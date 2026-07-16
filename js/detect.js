// detect.js — 網検出 + キャラ保護 (mask_net3.py の opencv.js 移植)
// メモリ制約: opencv.jsにフル解像度は渡さない。
//   検出=1600px / 保護=2048px(しきい値をスケール換算) / フル拡大はCanvas側
// 入力: smallData(1600w ImageData), midData(2048長辺 ImageData, kirara時のみ)
// 返り値: { mask, thin, subject } — すべて small スケールの cv.Mat(CV_8U)
"use strict";

const Detect = (() => {

function lineKernel(L, angDeg) {
  L = L | 1;
  const k = cv.Mat.zeros(L, L, cv.CV_8U);
  const c = (L - 1) / 2, a = angDeg * Math.PI / 180;
  const dx = Math.cos(a), dy = Math.sin(a);
  for (let t = -L / 2; t <= L / 2; t += 0.34) {
    const x = Math.round(c + dx * t), y = Math.round(c + dy * t);
    if (x >= 0 && x < L && y >= 0 && y < L) k.ucharPtr(y, x)[0] = 1;
  }
  return k;
}

function ell(k) { return cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(k | 1, k | 1)); }

function scalarMat(rows, cols, type, v) {
  return new cv.Mat(rows, cols, type, new cv.Scalar(v));
}

function orientedMorph(bin, angles, L, op) {
  const p = (L >> 1) + 1;
  const pad = new cv.Mat();
  cv.copyMakeBorder(bin, pad, p, p, p, p, cv.BORDER_REFLECT);
  const acc = (op === cv.MORPH_CLOSE) ? pad.clone() : cv.Mat.zeros(pad.rows, pad.cols, cv.CV_8U);
  const tmp = new cv.Mat();
  for (const ang of angles) {
    const k = lineKernel(L, ang);
    cv.morphologyEx(pad, tmp, op, k);
    cv.max(acc, tmp, acc);
    k.delete();
  }
  tmp.delete(); pad.delete();
  const roi = acc.roi(new cv.Rect(p, p, bin.cols, bin.rows));
  const out = roi.clone();
  roi.delete(); acc.delete();
  return out;
}

function localZ(bhF, win, zkFrac) {
  const m = new cv.Mat(), sq = new cv.Mat(), msq = new cv.Mat();
  const ksz = new cv.Size(win, win);
  cv.boxFilter(bhF, m, -1, ksz);
  cv.multiply(bhF, bhF, sq);
  cv.boxFilter(sq, msq, -1, ksz);
  const m2 = new cv.Mat(), varM = new cv.Mat(), sd = new cv.Mat();
  cv.multiply(m, m, m2);
  cv.subtract(msq, m2, varM);
  const z0 = scalarMat(varM.rows, varM.cols, varM.type(), 0);
  cv.max(varM, z0, varM);
  cv.sqrt(varM, sd);
  const mean = new cv.Mat(), std = new cv.Mat();
  cv.meanStdDev(bhF, mean, std);
  const gstd = std.doubleAt(0, 0) + 1e-6;
  const floorM = scalarMat(sd.rows, sd.cols, sd.type(), zkFrac * gstd);
  cv.max(sd, floorM, sd);
  const diff = new cv.Mat(), z = new cv.Mat();
  cv.subtract(bhF, m, diff);
  cv.divide(diff, sd, z);
  [m, sq, msq, m2, varM, z0, mean, std, floorM, diff].forEach(x => x.delete());
  sd.delete();
  return z;
}

function percentileOfMat(matF, pct) {
  const smp = new cv.Mat();
  const sc = Math.max(1, Math.floor(Math.sqrt(matF.rows * matF.cols / 250000)));
  cv.resize(matF, smp, new cv.Size(Math.max(1, Math.floor(matF.cols / sc)), Math.max(1, Math.floor(matF.rows / sc))));
  const arr = Float32Array.from(smp.data32F);
  smp.delete();
  arr.sort();
  return arr[Math.min(arr.length - 1, Math.floor(arr.length * pct / 100))];
}

function labelEq(lab, i, out) {
  const s = scalarMat(lab.rows, lab.cols, lab.type(), i);
  cv.compare(lab, s, out, cv.CMP_EQ);
  s.delete();
}

function subjectSilhouette(gray0, blurPct) {
  const lap = new cv.Mat(), lap2 = new cv.Mat(), focus = new cv.Mat();
  cv.Laplacian(gray0, lap, cv.CV_32F, 3);
  cv.multiply(lap, lap, lap2);
  cv.GaussianBlur(lap2, focus, new cv.Size(0, 0), 12);
  const thr = percentileOfMat(focus, blurPct);
  const sharp = new cv.Mat();
  cv.threshold(focus, sharp, thr, 255, cv.THRESH_BINARY);
  sharp.convertTo(sharp, cv.CV_8U);
  cv.morphologyEx(sharp, sharp, cv.MORPH_CLOSE, ell(25));
  const inv = new cv.Mat();
  cv.bitwise_not(sharp, inv);
  const lab = new cv.Mat(), stats = new cv.Mat(), cent = new cv.Mat();
  const n = cv.connectedComponentsWithStats(inv, lab, stats, cent, 8);
  const subject = sharp.clone();
  const H = sharp.rows, W = sharp.cols;
  const m = new cv.Mat();
  for (let i = 1; i < n; i++) {
    const x = stats.intAt(i, 0), y = stats.intAt(i, 1),
          w = stats.intAt(i, 2), h = stats.intAt(i, 3);
    if (x > 0 && y > 0 && x + w < W && y + h < H) {
      labelEq(lab, i, m);
      subject.setTo(new cv.Scalar(255), m);
    }
  }
  const lab2 = new cv.Mat(), st2 = new cv.Mat(), ce2 = new cv.Mat();
  const n2 = cv.connectedComponentsWithStats(subject, lab2, st2, ce2, 8);
  let amax = 0;
  for (let i = 1; i < n2; i++) amax = Math.max(amax, st2.intAt(i, 4));
  const subj2 = cv.Mat.zeros(H, W, cv.CV_8U);
  for (let i = 1; i < n2; i++) {
    if (st2.intAt(i, 4) >= 0.25 * amax) {
      labelEq(lab2, i, m);
      subj2.setTo(new cv.Scalar(255), m);
    }
  }
  cv.dilate(subj2, subj2, ell(11));
  [lap, lap2, focus, sharp, inv, lab, stats, cent, subject, lab2, st2, ce2, m].forEach(x => x.delete());
  return subj2;
}

function medianOfMaskedPixels(gray, maskMat) {
  const vals = [];
  const g = gray.data, m = maskMat.data, N = g.length;
  for (let i = 0; i < N; i += 3) if (m[i]) vals.push(g[i]);
  if (!vals.length) return -1;
  vals.sort((a, b) => a - b);
  return vals[vals.length >> 1];
}

// キャラ保護: midスケールで実行し、small スケールのマスクへ反映
// mask/thin は smallスケール(cv.Mat)。midData は 2048長辺 ImageData
function applyProtections(mask, thin, midData, smallW, smallH, P) {
  P("キャラ保護(口・目・鼻・肉球)…");
  const mid = cv.matFromImageData(midData);
  const mW = mid.cols, mH = mid.rows;
  const rgb = new cv.Mat(), gray = new cv.Mat(), hsv = new cv.Mat();
  cv.cvtColor(mid, rgb, cv.COLOR_RGBA2RGB);
  cv.cvtColor(rgb, gray, cv.COLOR_RGB2GRAY);
  cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
  mid.delete();
  // フル解像度→midのスケール係数(面積スケールはフル基準の値に q² を掛ける)
  // ここでは「midが約2048長辺」であることから、フル6000相当の係数 q=mW/6000 は不明のため
  // midスケールの実寸で直接パラメータ設定(2048長辺前提)
  const q = mW / 6000;                     // 参考値(6000pxフルを想定した既定)
  const area = v => Math.max(8, Math.round(v * q * q));
  const px = v => Math.max(1, Math.round(v * q));

  // 暗い塊 + 明るいリング
  const dark = new cv.Mat();
  cv.threshold(gray, dark, 60, 255, cv.THRESH_BINARY_INV);
  const pr = new cv.Mat();
  cv.morphologyEx(dark, pr, cv.MORPH_OPEN, ell(px(19)));
  dark.delete();
  const lb = new cv.Mat(), st = new cv.Mat(), ct = new cv.Mat();
  const nn = cv.connectedComponentsWithStats(pr, lb, st, ct, 8);
  pr.delete();
  const keepMask = cv.Mat.zeros(mH, mW, cv.CV_8U);
  const comp = new cv.Mat();
  for (let i = 1; i < nn; i++) {
    const a = st.intAt(i, 4);
    if (a < area(400) || a > 0.012 * mW * mH) continue;
    const x = st.intAt(i, 0), y = st.intAt(i, 1), w = st.intAt(i, 2), h = st.intAt(i, 3);
    const m2 = px(40);
    const xa = Math.max(0, x - m2), ya = Math.max(0, y - m2);
    const xb = Math.min(mW, x + w + m2), yb = Math.min(mH, y + h + m2);
    const r = new cv.Rect(xa, ya, xb - xa, yb - ya);
    const labRoi = lb.roi(r);
    labelEq(labRoi, i, comp);
    const ring = new cv.Mat(), compD = new cv.Mat();
    cv.dilate(comp, compD, ell(px(61)));
    cv.subtract(compD, comp, ring);
    const gRoi = gray.roi(r);
    const med = medianOfMaskedPixels(gRoi, ring);
    if ((med > 90 && a <= area(50000)) || med > 170) {
      const km = keepMask.roi(r);
      km.setTo(new cv.Scalar(255), comp);
      km.delete();
    }
    labRoi.delete(); ring.delete(); compD.delete(); gRoi.delete();
  }
  lb.delete(); st.delete(); ct.delete();

  // 鼻(オレンジのビニール)は保護しない
  const nose = new cv.Mat();
  const lo1 = new cv.Mat(mH, mW, cv.CV_8UC3, new cv.Scalar(0, 110, 85));
  const hi1 = new cv.Mat(mH, mW, cv.CV_8UC3, new cv.Scalar(25, 255, 255));
  cv.inRange(hsv, lo1, hi1, nose);
  lo1.delete(); hi1.delete();
  cv.morphologyEx(nose, nose, cv.MORPH_OPEN, ell(px(7)));
  cv.dilate(nose, nose, ell(px(9)));
  keepMask.setTo(new cv.Scalar(0), nose);
  nose.delete();

  const protectD = new cv.Mat();
  cv.dilate(keepMask, protectD, ell(px(9)));
  keepMask.delete();
  // mid → small へ縮小し、mask から除外
  const protS = new cv.Mat();
  cv.resize(protectD, protS, new cv.Size(smallW, smallH), 0, 0, cv.INTER_NEAREST);
  protectD.delete();
  mask.setTo(new cv.Scalar(0), protS);
  protS.delete();

  // 肉球: ピンク円盤 → 細マスク(占有率キャップ)
  const pink = new cv.Mat();
  const lo2 = new cv.Mat(mH, mW, cv.CV_8UC3, new cv.Scalar(140, 70, 110));
  const hi2 = new cv.Mat(mH, mW, cv.CV_8UC3, new cv.Scalar(178, 255, 255));
  cv.inRange(hsv, lo2, hi2, pink);
  lo2.delete(); hi2.delete();
  cv.morphologyEx(pink, pink, cv.MORPH_OPEN, ell(px(15)));
  // mid → small スケールへ
  const pinkS = new cv.Mat();
  cv.resize(pink, pinkS, new cv.Size(smallW, smallH), 0, 0, cv.INTER_NEAREST);
  pink.delete();
  const pl = new cv.Mat(), ps = new cv.Mat(), pc = new cv.Mat();
  const np_ = cv.connectedComponentsWithStats(pinkS, pl, ps, pc, 8);
  const sS = smallW / 6000;
  const areaS = v => Math.max(4, Math.round(v * sS * sS));
  const thinD = new cv.Mat();
  // 17pxフル解像度相当を small スケールへ (1600/6000 ≒ 0.27 → 5px)
  cv.dilate(thin, thinD, ell(Math.max(3, Math.round(17 * sS))));
  const sel = new cv.Mat();
  for (let i = 1; i < np_; i++) {
    const a = ps.intAt(i, 4);
    if (a < areaS(3000) || a > areaS(150000)) continue;
    const x = ps.intAt(i, 0), y = ps.intAt(i, 1), w = ps.intAt(i, 2), h = ps.intAt(i, 3);
    const r = new cv.Rect(x, y, w, h);
    const plRoi = pl.roi(r);
    labelEq(plRoi, i, sel);
    const tdRoi = thinD.roi(r), tRoi = thin.roi(r), mRoi = mask.roi(r);
    const inter = new cv.Mat();
    cv.bitwise_and(tdRoi, sel, inter);
    const frac = cv.countNonZero(inter) / Math.max(1, cv.countNonZero(sel));
    const useMat = (frac <= 0.35) ? tdRoi : tRoi;
    mRoi.setTo(new cv.Scalar(0), sel);
    const useSel = new cv.Mat();
    cv.bitwise_and(useMat, sel, useSel);
    cv.bitwise_or(mRoi, useSel, mRoi);
    [plRoi, tdRoi, tRoi, mRoi, inter, useSel].forEach(xm => xm.delete());
  }
  sel.delete(); pl.delete(); ps.delete(); pc.delete(); pinkS.delete(); thinD.delete();
  rgb.delete(); gray.delete(); hsv.delete();
}

// メイン。smallData: 1600w ImageData / midData: 2048長辺 ImageData(kirara時)
function detectNet(smallData, midData, opts) {
  const P = opts.progress || (() => {});
  const kirara = !!opts.kirara;
  const workW = smallData.width, workH = smallData.height;

  P("前処理…");
  const small = cv.matFromImageData(smallData);
  const rgb = new cv.Mat();
  cv.cvtColor(small, rgb, cv.COLOR_RGBA2RGB);
  small.delete();
  const gray0 = new cv.Mat();
  cv.cvtColor(rgb, gray0, cv.COLOR_RGB2GRAY);

  P("網の証拠マップ(blackhat)…");
  const bhK = ell(13);
  const clahe = new cv.CLAHE(2.0, new cv.Size(16, 16));
  const chans = new cv.MatVector();
  cv.split(rgb, chans);
  let blackhat = cv.Mat.zeros(workH, workW, cv.CV_8U);
  for (let ci = 0; ci < 3; ci++) {
    const c = chans.get(ci), ce = new cv.Mat(), bh = new cv.Mat();
    clahe.apply(c, ce);
    cv.morphologyEx(ce, bh, cv.MORPH_BLACKHAT, bhK);
    cv.max(blackhat, bh, blackhat);
    c.delete(); ce.delete(); bh.delete();
  }
  chans.delete(); clahe.delete(); rgb.delete();

  P("二値化と方向性フィルタ…");
  const adap = new cv.Mat(), minM = new cv.Mat(), binimg = new cv.Mat();
  cv.adaptiveThreshold(blackhat, adap, 255, cv.ADAPTIVE_THRESH_MEAN_C, cv.THRESH_BINARY, 41, -7);
  cv.threshold(blackhat, minM, 6, 255, cv.THRESH_BINARY);
  cv.bitwise_and(adap, minM, binimg);
  adap.delete(); minM.delete();

  const Hang = [-30, -20, -10, 0, 10, 20, 30];
  const Vang = [60, 70, 80, 90, 100, 110, 120];
  let Hm = orientedMorph(binimg, Hang, 21, cv.MORPH_OPEN);
  let Vm = orientedMorph(binimg, Vang, 21, cv.MORPH_OPEN);
  const Hm2 = orientedMorph(Hm, Hang, 41, cv.MORPH_CLOSE);
  const Vm2 = orientedMorph(Vm, Vang, 41, cv.MORPH_CLOSE);
  Hm.delete(); Vm.delete(); Hm = Hm2; Vm = Vm2;
  const netHV = new cv.Mat();
  cv.bitwise_or(Hm, Vm, netHV);

  P("格子の連結性チェック…");
  const d7 = ell(7), Hd = new cv.Mat(), Vd = new cv.Mat(), cross = new cv.Mat();
  cv.dilate(Hm, Hd, d7); cv.dilate(Vm, Vd, d7);
  cv.bitwise_and(Hd, Vd, cross);
  Hd.delete(); Vd.delete(); Hm.delete(); Vm.delete();

  const lab = new cv.Mat(), stats = new cv.Mat(), cent = new cv.Mat();
  const n = cv.connectedComponentsWithStats(netHV, lab, stats, cent, 8);
  const crossLabels = new Set();
  { const ld = lab.data32S, cd = cross.data;
    for (let i = 0; i < cd.length; i++) if (cd[i]) crossLabels.add(ld[i]); }
  crossLabels.delete(0);
  let net = cv.Mat.zeros(workH, workW, cv.CV_8U);
  { const ld = lab.data32S, nd = net.data;
    const keep = new Uint8Array(n);
    for (let i = 1; i < n; i++)
      if (crossLabels.has(i) || stats.intAt(i, 4) >= 40) keep[i] = 1;
    for (let i = 0; i < ld.length; i++) if (keep[ld[i]]) nd[i] = 255; }
  lab.delete(); stats.delete(); cent.delete(); netHV.delete();

  const netThin = net.clone();
  const knotD = new cv.Mat();
  cv.dilate(cross, knotD, ell(9));
  cv.bitwise_or(net, knotD, net);
  cross.delete(); knotD.delete();

  P("被写体シルエットと背景検出…");
  const bhF = new cv.Mat();
  blackhat.convertTo(bhF, cv.CV_32F);
  const z = localZ(bhF, 35, 0.15);
  const zbin = new cv.Mat(), gate = new cv.Mat(), binz = new cv.Mat();
  cv.threshold(z, zbin, 0.7, 255, cv.THRESH_BINARY);
  zbin.convertTo(zbin, cv.CV_8U);
  cv.threshold(blackhat, gate, 3, 255, cv.THRESH_BINARY);
  cv.bitwise_and(zbin, gate, binz);
  zbin.delete(); gate.delete(); z.delete(); bhF.delete();
  cv.morphologyEx(binz, binz, cv.MORPH_CLOSE, ell(3));
  let bg = orientedMorph(binz, Hang.concat(Vang), 9, cv.MORPH_OPEN);
  cv.morphologyEx(bg, bg, cv.MORPH_CLOSE, ell(5));
  binz.delete();

  const subject = subjectSilhouette(gray0, 55);
  const bgzone = new cv.Mat();
  cv.bitwise_not(subject, bgzone);
  cv.bitwise_and(bg, bgzone, bg);
  { const bgF = new cv.Mat(), dens = new cv.Mat();
    bg.convertTo(bgF, cv.CV_32F, 1 / 255.0);
    cv.boxFilter(bgF, dens, -1, new cv.Size(101, 101));
    const dm = new cv.Mat();
    cv.threshold(dens, dm, 0.30, 255, cv.THRESH_BINARY);
    dm.convertTo(dm, cv.CV_8U);
    bg.setTo(new cv.Scalar(0), dm);
    bgF.delete(); dens.delete(); dm.delete(); }
  cv.dilate(bg, bg, ell(3));
  cv.max(net, bg, net);
  bg.delete(); bgzone.delete();

  P("マスク仕上げ…");
  const big = new cv.Mat(), smallG = new cv.Mat();
  cv.dilate(net, big, ell(11));
  cv.dilate(net, smallG, ell(5));
  const mask = big.clone();
  smallG.copyTo(mask, subject);
  net.delete(); big.delete(); smallG.delete();
  blackhat.delete(); binimg.delete(); gray0.delete();

  if (kirara && midData) {
    applyProtections(mask, netThin, midData, workW, workH, P);
  }

  return { mask, thin: netThin, subject };
}

// 残骸スイープ: 除去結果(smallスケール)の背景ゾーンに残った小さな暗い塊を検出
// smallResData: 結果画像の small ImageData / subjectMat: 被写体シルエット(small)
function sweepSpecks(smallResData, subjectMat, zThr = 1.5, minA = 8, maxA = 1200) {
  const mat = cv.matFromImageData(smallResData);
  const rgb = new cv.Mat();
  cv.cvtColor(mat, rgb, cv.COLOR_RGBA2RGB);
  mat.delete();
  const clahe = new cv.CLAHE(2.0, new cv.Size(16, 16));
  const chans = new cv.MatVector();
  cv.split(rgb, chans);
  rgb.delete();
  const k17 = ell(17);
  let bh = cv.Mat.zeros(smallResData.height, smallResData.width, cv.CV_8U);
  for (let ci = 0; ci < 3; ci++) {
    const c = chans.get(ci), ce = new cv.Mat(), b = new cv.Mat();
    clahe.apply(c, ce);
    cv.morphologyEx(ce, b, cv.MORPH_BLACKHAT, k17);
    cv.max(bh, b, bh);
    c.delete(); ce.delete(); b.delete();
  }
  chans.delete(); clahe.delete();
  const bhF = new cv.Mat();
  bh.convertTo(bhF, cv.CV_32F);
  const z = localZ(bhF, 35, 0.1);
  const zb = new cv.Mat(), gate = new cv.Mat(), cand = new cv.Mat();
  cv.threshold(z, zb, zThr, 255, cv.THRESH_BINARY);
  zb.convertTo(zb, cv.CV_8U);
  cv.threshold(bh, gate, 8, 255, cv.THRESH_BINARY);
  cv.bitwise_and(zb, gate, cand);
  zb.delete(); gate.delete(); z.delete(); bhF.delete(); bh.delete();
  // 被写体の外だけ
  if (subjectMat) {
    const bgz = new cv.Mat();
    cv.bitwise_not(subjectMat, bgz);
    cv.bitwise_and(cand, bgz, cand);
    bgz.delete();
  }
  const lab = new cv.Mat(), st = new cv.Mat(), ct = new cv.Mat();
  const n = cv.connectedComponentsWithStats(cand, lab, st, ct, 8);
  const keep = cv.Mat.zeros(cand.rows, cand.cols, cv.CV_8U);
  let any = false;
  { const ld = lab.data32S, kd = keep.data;
    const ok = new Uint8Array(n);
    for (let i = 1; i < n; i++) {
      const a = st.intAt(i, 4);
      if (a >= minA && a <= maxA) { ok[i] = 1; any = true; }
    }
    if (any) for (let i = 0; i < ld.length; i++) if (ok[ld[i]]) kd[i] = 255;
  }
  lab.delete(); st.delete(); ct.delete(); cand.delete();
  if (!any) { keep.delete(); return null; }
  cv.dilate(keep, keep, ell(9));
  return keep;
}

return { detectNet, sweepSpecks };
})();
