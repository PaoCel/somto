import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pages = [
  { path: "../../public/support.html", lang: "it", alternate: "/en/support.html" },
  { path: "../../public/en/support.html", lang: "en", alternate: "/support.html" },
];

for (const page of pages) {
  test(`support page ${page.lang} uses the public Somto shell`, async () => {
    const html = await readFile(new URL(page.path, import.meta.url), "utf8");

    assert.match(html, /<body class="lp-body support-page" data-no-shell>/);
    assert.match(html, /class="lp-nav-logo"/);
    assert.match(html, /src="\/icons\/somto-wordmark\.png"/);
    assert.match(html, /aria-label="(?:Menu principale|Main menu)"/);
    assert.match(html, /href="\/blog\/"/);
    assert.match(html, /href="\/login\.html\?next=\/home\.html"/);
    assert.match(html, new RegExp(`href="${page.alternate.replaceAll("/", "\\/")}"`));
    assert.match(html, /<footer class="lp-footer">/);
  });
}

test("support pages expose direct help and safety paths", async () => {
  const [italian, english] = await Promise.all(
    pages.map((page) => readFile(new URL(page.path, import.meta.url), "utf8")),
  );

  for (const html of [italian, english]) {
    assert.match(html, /mailto:support@somto\.it/);
    assert.match(html, /href="\/settings\.html"/);
    assert.match(html, /href="\/privacy\.html"/);
    assert.match(html, /css\/pages\/support\.css/);
  }

  assert.match(italian, /id="sicurezza"/);
  assert.match(english, /id="safety"/);
});
