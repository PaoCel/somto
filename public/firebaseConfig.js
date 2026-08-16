// firebaseConfig.js
// Firebase web config is not a secret (it's required client-side).
// Ambiente scelto per hostname: gli host di staging usano il progetto
// somto-staging (dati isolati), tutti gli altri (somto.it, gia-visto.web.app,
// localhost) restano su prod. Vedi docs/STAGING.md.
(function () {
  var host = (typeof window !== "undefined" && window.location && window.location.hostname) || "";
  var isStaging = host === "somto-staging.web.app" || host === "somto-staging.firebaseapp.com";

  var prodConfig = {
    apiKey: "AIzaSyCf5Gi9TZNzJGeZGhW_7zM9zASplIC6GBw",
    // authDomain custom: il popup/redirect Google-Apple mostra somto.it
    // (l'handler /__/auth/* è servito dallo stesso hosting). Prerequisiti
    // registrati il 2026-07-12: origin+redirect URI sul client OAuth Google
    // e Return URL sul Services ID Apple (vedi docs/RUNBOOK.md).
    authDomain: "somto.it",
    projectId: "gia-visto",
    storageBucket: "gia-visto.firebasestorage.app",
    messagingSenderId: "538597925021",
    appId: "1:538597925021:web:30d160b1a8c5e71c293474",
    measurementId: "G-K9B19SSJEY",
    appCheck: {
      enabled: false,
      provider: "recaptchaV3",
      siteKey: "",
      debugToken: "",
      autoRefresh: true,
    }
  };

  var stagingConfig = {
    apiKey: "AIzaSyCA65xYUxWnBsss8FH3v4Uhjos_-jvt8Tw",
    authDomain: "somto-staging.firebaseapp.com",
    projectId: "somto-staging",
    storageBucket: "somto-staging.firebasestorage.app",
    messagingSenderId: "155939672817",
    appId: "1:155939672817:web:5661b18370e9e81e480f50",
    appCheck: {
      enabled: false,
      provider: "recaptchaV3",
      siteKey: "",
      debugToken: "",
      autoRefresh: true,
    }
  };

  window.firebaseConfig = isStaging ? stagingConfig : prodConfig;
  window.__SOMTO_ENV__ = isStaging ? "staging" : "production";
})();

// TMDB API config (public client-side key, same approach as Firebase).
window.tmdbConfig = {
  apiKey: "cd31d1fdbf78c125a0c97fc07e34e271",
  baseUrl: "https://api.themoviedb.org/3",
  imageBaseUrl: "https://image.tmdb.org/t/p",
};
