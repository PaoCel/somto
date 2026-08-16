import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");

test("toast feedback always mounts in the viewport and expires independently", async () => {
  const [source, styles] = await Promise.all([
    read("public/js/components/toast.js"),
    read("public/css/components/toast.css"),
  ]);

  assert.match(source, /document\.body\.appendChild\(wrap\)/);
  assert.match(source, /wrap\.classList\.add\("toast-container"\)/);
  assert.match(source, /const timerId = window\.setTimeout/);
  assert.doesNotMatch(source, /^let timerId/m);
  assert.match(styles, /\.toast-container[\s\S]*position:\s*fixed/);
});

test("high-risk PWA actions use visible pending states", async () => {
  const [title, onboarding, appShell, notifications] = await Promise.all([
    read("public/js/pages/title.page.js"),
    read("public/js/components/onboardingFlow.js"),
    read("public/js/components/appShell.js"),
    read("public/js/pages/home.page.js"),
  ]);

  assert.match(title, /runWithButtonLoading/);
  assert.match(title, /input\.setAttribute\("aria-busy", "true"\)/);
  assert.match(title, /track\.classList\.add\("is-saving"\)/);
  assert.match(onboarding, /state\.isTransitioning/);
  assert.match(onboarding, /nextBtn\.setAttribute\("aria-busy", "true"\)/);
  assert.match(appShell, /loadingLabel:\s*i18nT\("Uscita\.\.\."\)/);
  assert.match(notifications, /markAllAsRead[\s\S]*runWithButtonLoading/);
});

test("social login stays actionable and explains missing terms at click time", async () => {
  const [markup, logic] = await Promise.all([
    read("public/login.html"),
    read("public/js/pages/login.page.js"),
  ]);

  assert.doesNotMatch(markup, /id="btnApple"[^>]*disabled/);
  assert.doesNotMatch(markup, /id="btnGoogle"[^>]*disabled/);
  assert.match(logic, /function requireTermsAcceptance/);
  assert.match(logic, /btnApple[\s\S]*requireTermsAcceptance/);
  assert.match(logic, /btnGoogle[\s\S]*requireTermsAcceptance/);
});

test("avatar upload requires an explicit crop confirmation", async () => {
  const [markup, logic] = await Promise.all([
    read("public/account.html"),
    read("public/js/pages/account.page.js"),
  ]);

  assert.match(markup, /id="avatarCropModal"/);
  assert.match(markup, /id="avatarCropZoom"/);
  assert.match(logic, /buildCroppedAvatarFile/);
  assert.match(logic, /btnAvatarCropConfirm[\s\S]*runWithButtonLoading/);
});
