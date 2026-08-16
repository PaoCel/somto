import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("support pages mount the authenticated realtime chat", async () => {
  const [italian, english] = await Promise.all([
    read("../../public/support.html"),
    read("../../public/en/support.html"),
  ]);

  for (const html of [italian, english]) {
    assert.match(html, /id="supportChat"/);
    assert.match(html, /id="supportChatMessages"[^>]+role="log"/);
    assert.match(html, /id="supportChatForm"/);
    assert.match(html, /id="supportChatInput"[^>]+maxlength="2000"/);
    assert.match(html, /id="supportChatHandoff"/);
    assert.match(html, /src="\/js\/pages\/support\.page\.js"/);
    assert.match(html, /mailto:support@somto\.it/);
    assert.doesNotMatch(html, /attivat[oa] le notifiche|notifications are enabled/i);
  }
});

test("support chat sends through the callable and listens to the latest messages", async () => {
  const [page, api] = await Promise.all([
    read("../../public/js/pages/support.page.js"),
    read("../../public/js/api/threads.api.js"),
  ]);

  assert.match(page, /event\.preventDefault\(\)/);
  assert.match(page, /listenLatestThreadMessages/);
  assert.match(page, /sendSupportThreadMessage/);
  assert.match(page, /new URL\("\/thread\.html", window\.location\.origin\)/);
  assert.match(page, /handoffURL\.searchParams\.set\("tid", activeThreadId\)/);
  assert.doesNotMatch(page, /location\.reload/);
  assert.match(api, /httpsCallable\(functions, "sendThreadMessage"\)/);
  assert.match(api, /orderBy\("createdAt", "desc"\)/);
  assert.match(api, /\.reverse\(\)/);
});

test("support inbox is available to users and keeps admin-only reply badges", async () => {
  const [html, page, api] = await Promise.all([
    read("../../public/threads.html"),
    read("../../public/js/pages/threads.page.js"),
    read("../../public/js/api/threads.api.js"),
  ]);

  assert.match(html, /id="supportThreadsTab"[^>]+hidden/);
  assert.match(page, /supportThreadsTab\.hidden = !user/);
  assert.match(page, /canManageSupportInbox = meDoc\?\.isAdmin === true/);
  assert.match(page, /canManageSupportInbox && activeFilter === "support"/);
  assert.match(page, /listenMyThreads\(user\.uid/);
  assert.match(page, /lastSenderUid !== currentUser\?\.uid/);
  assert.match(api, /where\("participants", "array-contains", uid\)/);
  assert.match(api, /orderBy\("lastMessageAt", "desc"\)/);
});

test("support threads never expose or send the spoiler flag", async () => {
  const [page, functions] = await Promise.all([
    read("../../public/js/pages/thread.page.js"),
    read("../../functions/index.js"),
  ]);

  assert.match(page, /!sendBtn\.__spoilerMounted && !isSupportThreadData\(\)/);
  assert.match(page, /!isSupportThreadData\(\) && spoilerComposerCtrl/);
  assert.doesNotMatch(page, /mountNotificationPermissionBanner/);
  assert.doesNotMatch(page, /Attiva le notifiche/);
  assert.doesNotMatch(functions, /Attiva le notifiche per sapere subito/);
  assert.match(functions, /La ritrovi in Messaggi → Assistenza/);
});
