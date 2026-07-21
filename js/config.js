// アプリ設定
window.APP_CONFIG = {
  // Google認証 (Google Identity Services)
  //   有効化: Google Cloud Console → APIとサービス → 認証情報 →
  //   「OAuth クライアント ID (ウェブ アプリケーション)」を作成し、
  //   承認済みJavaScript生成元に公開URL(例 https://xxx.github.io)を追加して
  //   ここにクライアントIDを貼る。空文字なら認証なしで誰でも使える。
  //   一旦ログイン無効化中(2026-07-21ユーザー指示)。戻すときは下のIDを googleClientId に設定:
  //   "842344178276-ak9n9mes55of1d22nu9l1v0uvslem22v.apps.googleusercontent.com"
  googleClientId: "",

  // ログインを許可するメールアドレス(空配列なら誰でもログイン可)
  allowedEmails: [],

  // 匿名利用統計・要望収集 (PostHog)
  //   空文字なら完全無効(スクリプトも読み込まず、ボタンも表示しない)。
  //   有効化するにはPostHogプロジェクトのAPIキー("phc_...")を貼る。
  posthogToken: "",
  posthogHost: "https://us.i.posthog.com",

  // ☁️ サーバー高画質処理のブローカーAPI (空文字なら機能OFF・チップも出ない)
  //   開発: "http://localhost:8825" (mock_broker.mjs) / 本番: Cloudflare WorkerのURL
  gpuBrokerUrl: "https://apiphotoapp.omusuvy.com",
};
