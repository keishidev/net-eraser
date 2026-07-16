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
};
