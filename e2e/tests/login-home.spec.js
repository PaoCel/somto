import { test, expect } from "@playwright/test";
import { defaultEmulatorConfig, e2eUser, e2eActor } from "../config.mjs";

const EMULATOR_FLAG_KEY = "__2WATCH_USE_FIREBASE_EMULATORS__";
const EMULATOR_CONFIG_KEY = "__2WATCH_FIREBASE_EMULATORS__";

async function enableFirebaseEmulators(page) {
  await page.addInitScript(([flagKey, cfgKey, cfg]) => {
    window.__USE_FIREBASE_EMULATORS__ = true;
    window.__FIREBASE_EMULATORS__ = cfg;
    try {
      localStorage.setItem(flagKey, "1");
      localStorage.setItem(cfgKey, JSON.stringify(cfg));
    } catch (_) {}
  }, [EMULATOR_FLAG_KEY, EMULATOR_CONFIG_KEY, defaultEmulatorConfig]);
}

async function loginWithSeededUser(page) {
  await page.goto("/login.html?emulators=1");
  await expect(page.locator("#authForm")).toBeVisible();
  await page.waitForFunction(() => window.__2WATCH_EMULATORS_CONNECTED__ === true, null, {
    timeout: 20_000,
  });
  await page.fill("#email", e2eUser.email);
  await page.fill("#password", e2eUser.password);
  await page.click("#btnSubmit");
  await page.waitForURL((url) => url.pathname.endsWith("/account.html"), { timeout: 20_000 });
}

test.beforeEach(async ({ page }) => {
  page.on("console", (message) => {
    if (message.type() === "error") {
      console.log(`[browser console] ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => {
    console.log(`[browser pageerror] ${error.message}`);
  });
  await enableFirebaseEmulators(page);
});

test("login email seeded utente su auth emulator", async ({ page }) => {
  await loginWithSeededUser(page);
  await expect(page).toHaveURL(/\/account\.html/);
});

test("community completa il caricamento feed con fallback supportato", async ({ page }) => {
  await loginWithSeededUser(page);
  await page.goto("/community.html?emulators=1");

  await expect(page).toHaveURL(/\/community\.html/);
  const skipTutorial = page.getByRole("button", { name: "Salta" });
  await skipTutorial.waitFor({ state: "visible", timeout: 5_000 }).catch(() => {});
  if (await skipTutorial.isVisible().catch(() => false)) {
    await skipTutorial.click();
  }
  await page.waitForFunction((projectId) => {
    const runtimeProjectId = window.firebaseConfig?.projectId;
    const emu = window.__2WATCH_EMULATORS_CONFIG__;
    return runtimeProjectId === projectId && emu?.projectId === projectId;
  }, defaultEmulatorConfig.projectId, {
    timeout: 20_000,
  });
  await page.waitForFunction(() => {
    const mode = window.__2WATCH_LAST_FEED_MODE;
    return mode === "server" || mode === "legacy";
  }, null, {
    timeout: 20_000,
  });
  const mode = await page.evaluate(() => window.__2WATCH_LAST_FEED_MODE);
  expect(["server", "legacy"]).toContain(mode);

  await expect(page.locator("#feed")).toHaveCount(1);
});
