# 🥎 ネット消しゴム

防球ネット越しに撮った写真から、ネットをきれいに消したり、うっすら残したりできるWebアプリ。
**すべての処理がブラウザ内で完結**します（写真はどこにもアップロードされません）。

## 特徴
- 🔍 ネット自動検出（opencv.js / WASM）
- 🎨 AIインペイント: 高品質 **LaMa** / 軽量 **MI-GAN**（ONNX Runtime Web / **WebGPU**）
- 🎚 ネットの濃さスライダー（0%=完全除去 〜 100%=元のまま）リアルタイム
- 🖐 画像長押しで元写真と比較
- 🖌 保護ブラシ（なぞった場所は変換しない）
- 🐹 キララモード（マスコットの顔・肉球を自動保護）/ 🌏 汎用モード
- ⚡ 起動時にWebGPU対応を自動チェック

## 使い方（ローカル）
```bash
cd webapp
python -m http.server 8823
# → http://localhost:8823/
```
初回はAIモデル（27MB or 198MB）を自動ダウンロードします（以後キャッシュ）。

## 公開（静的ホスティング）
GitHub Pages / Cloudflare Pages などにそのまま配置できます。
`models/` の大きいモデルはリポジトリに含めなくてもOK（Hugging Faceから自動取得します）。

## Google認証（任意）
`js/config.js` の `googleClientId` にOAuthクライアントIDを設定するとログインゲートが有効になります。
1. [Google Cloud Console](https://console.cloud.google.com/apis/credentials) → 認証情報 → OAuthクライアントID（ウェブアプリ）を作成
2. 「承認済みのJavaScript生成元」に公開URL（例 `https://xxxx.github.io`）を追加
3. クライアントIDを `js/config.js` に貼り付け
4. `allowedEmails` に許可したいGmailアドレスを列挙（空なら誰でもログイン可）

## 実測パフォーマンス（RTX 5070 Ti / Chrome / 24MP写真）
| 工程 | 高品質(LaMa) | 標準(MI-GAN) |
|---|---|---|
| 検出 | 約6秒 | 約6秒 |
| インペイント一式 | 約70秒 | 約35秒 |

## 使用モデル・ライセンス
- [LaMa](https://github.com/advimman/lama) (ONNX変換: [Carve/LaMa-ONNX](https://huggingface.co/Carve/LaMa-ONNX))
- [MI-GAN](https://github.com/Picsart-AI-Research/MI-GAN) (ONNX: [andraniksargsyan/migan](https://huggingface.co/andraniksargsyan/migan))
- [opencv.js](https://opencv.org/) / [ONNX Runtime Web](https://onnxruntime.ai/)
