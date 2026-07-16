// auth.js — Google認証ゲート (Google Identity Services)
// config.js の googleClientId が空なら何もしない(認証オフ)。
"use strict";

(() => {
const cfg = window.APP_CONFIG || {};
const gate = !!cfg.googleClientId;
const login = document.getElementById("login");
const setup = document.getElementById("setup");
const userchip = document.getElementById("userchip");

window.AUTH_OK = !gate;   // app.js が参照

if (!gate) return;

// 認証必要: セッションに記録があれば復元
const saved = sessionStorage.getItem("auth_email");
if (saved) { grant(saved); return; }

// ログイン画面を表示
setup.hidden = true;
login.hidden = false;

const s = document.createElement("script");
s.src = "https://accounts.google.com/gsi/client";
s.async = true; s.defer = true;
s.onload = () => {
  google.accounts.id.initialize({
    client_id: cfg.googleClientId,
    callback: onCredential,
  });
  google.accounts.id.renderButton(document.getElementById("gsi-button"), {
    theme: "filled_blue", size: "large", text: "signin_with", locale: "ja",
  });
};
document.head.appendChild(s);

function onCredential(resp) {
  try {
    const payload = JSON.parse(atob(resp.credential.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    const email = payload.email || "";
    if (cfg.allowedEmails.length && !cfg.allowedEmails.includes(email)) {
      document.getElementById("loginmsg").textContent =
        `このアカウント(${email})には利用権限がありません`;
      return;
    }
    sessionStorage.setItem("auth_email", email);
    grant(email);
  } catch (e) {
    document.getElementById("loginmsg").textContent = "ログインに失敗しました";
  }
}

function grant(email) {
  window.AUTH_OK = true;
  login.hidden = true;
  setup.hidden = false;
  userchip.hidden = false;
  userchip.textContent = `👤 ${email}`;
}
})();
