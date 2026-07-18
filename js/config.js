// アプリ設定
window.APP_CONFIG = {
  // Google認証 (Google Identity Services)
  //   有効化: Google Cloud Console → APIとサービス → 認証情報 →
  //   「OAuth クライアント ID (ウェブ アプリケーション)」を作成し、
  //   承認済みJavaScript生成元に公開URL(例 https://xxx.github.io)を追加して
  //   ここにクライアントIDを貼る。空文字なら認証なしで誰でも使える。
  googleClientId: "",

  // ログインを許可するメールアドレス(空配列なら誰でもログイン可)
  allowedEmails: [],

  // 匿名利用統計・要望収集 (PostHog)
  //   空文字なら完全無効(スクリプトも読み込まず、ボタンも表示しない)。
  //   有効化するにはPostHogプロジェクトのAPIキー("phc_...")を貼る。
  posthogToken: "",
  posthogHost: "https://us.i.posthog.com",
};
