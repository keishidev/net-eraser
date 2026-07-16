# ネット消しゴム (WebGPU版)

防球ネット越しの写真から網を消す／薄くするWebアプリ。**全処理がブラウザ内で完結**（写真はどこにも送信されない・サーバー代ゼロ）。

## 実測 (RTX 5070 Ti / Chrome / 24MP写真)
- 検出 5.5s (opencv.js WASM) + インペイント 17.6s (**WebGPU**) ≒ 23秒
- モデルDL 初回のみ 27MB (キャッシュされる)

## 構成
```
index.html / style.css
js/detect.js   … 網検出 + キャラ保護 (Pythonパイプラインの opencv.js 移植)
                  検出1600px / 保護2048px / フル解像度Matは作らない(WASMヒープ対策)
js/inpaint.js  … MI-GAN pipeline_v2 ONNX を onnxruntime-web で512タイル実行
                  (uint8入出力, マスクは穴=0, コサイン窓ブレンド, WebGPU→WASMフォールバック)
js/app.js      … UI・フル解像度合成・網の濃さスライダー(リアルタイム)
models/        … migan_pipeline_v2.onnx (無い場合はHugging FaceからCDN取得)
vendor/opencv.js
```

## 起動 (ローカル)
```
cd webapp
python -m http.server 8823
# → http://localhost:8823/
```

## 公開 (GitHub Pages等の静的ホスティング)
- `webapp/` をそのまま公開。`models/` は容量が大きければ除外してOK
  (inpaint.js が Hugging Face から自動フェッチ: andraniksargsyan/migan)
- WebGPU必須ではない: 非対応ブラウザはWASMに自動フォールバック(遅い)

## 技術メモ / 学び
- LaMa ONNX (Carve, 198MB) はFFTをEinsum/MatMulに展開した変換版だが、
  **ort-web の WebGPU EP では FFC 内の Add がシェイプ非対応で実行時失敗**
  (wasmフォールバックは動くが遅すぎ) → **MI-GAN pipeline_v2 (27MB, 畳み込みのみ)** に変更
- MI-GAN pipeline_v2 の入力規約: image uint8 [1,3,H,W] RGB / mask uint8 [1,1,H,W]
  **穴=0, 保持=255** (inpaint-web と同じ)。出力 uint8 RGB
- opencv.js のWASMヒープは24MP RGBA(96MB)の一括確保で死ぬ
  → フル解像度はJS側(Canvas/TypedArray)のみで扱い、cv.Matは常に縮小版

## 今後の改善候補
- [ ] 検出をWeb Workerへ(処理中のUIフリーズ解消・進捗表示を正確に)
- [ ] Python版finalizeの残り(残骸スイープ・輪郭復元)の移植
- [ ] LaMa高品質モード(WASM実行を選択式で)
- [ ] スマホ対応(メモリ制約でタイル数制限)
