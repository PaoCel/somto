import test from "node:test";
import assert from "node:assert/strict";

import { buildSignupAttribution } from "../../public/js/utils/signupAttribution.js";

test("signup attribution conserva solo path, hostname e UTM minimizzate", () => {
  assert.deepEqual(buildSignupAttribution({
    pageUrl: "https://somto.it/login.html?utm_source=newsletter%20summer&utm_medium=email&token=secret#fragment",
    referrer: "https://news.example.org/article?id=private",
    language: "it-IT",
    analyticsConsent: true,
  }), {
    surface: "web",
    appVersion: "web",
    landingPath: "/login.html",
    referrerHost: "news.example.org",
    utmSource: "newslettersummer",
    utmMedium: "email",
    utmCampaign: null,
    language: "it-IT",
    analyticsConsent: true,
    selfReportedSource: null,
  });
});
