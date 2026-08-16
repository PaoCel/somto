const test = require("node:test");
const assert = require("node:assert/strict");

const admin = require("firebase-admin");

const {
  registerOfficialUpdatePage,
  _normalizeSlug: normalizeSlug,
  _readSlugParam: readSlugParam,
  _officialPostIdForSlug: officialPostIdForSlug,
  _buildOfficialUpdateUrl: buildOfficialUpdateUrl,
  _isServableOfficialPost: isServableOfficialPost,
  _paragraphsHtml: paragraphsHtml,
  _renderOfficialUpdatePage: renderOfficialUpdatePage,
} = require("../../modules/officialUpdatePage");

const OFFICIAL_POST = {
  authorUid: "somto_official",
  authorName: "Somto",
  text: "Insidious esce al cinema il 19 agosto.\n\nSegna la data.",
  visibility: "public",
  isOfficialUpdate: true,
  kind: "post",
  linkedTitleIds: ["insidious-2010"],
  officialUpdate: {
    slug: "insidious-al-cinema-il-19-agosto",
    updateType: "release_date",
    sourceUrls: ["https://example.com/news"],
    title: "Insidious esce al cinema il 19 agosto",
    summary: "La data ufficiale è arrivata.",
  },
};

// --- il test che conta: nessun post utente esce da questa pagina -----------

test("un post utente non editoriale non e' servibile (404)", () => {
  const userPost = {
    authorUid: "uid-utente-vero",
    authorName: "Paolo",
    text: "Post pubblico fra gli iscritti, non sul web aperto",
    visibility: "public",
    kind: "post",
  };
  assert.equal(isServableOfficialPost(userPost), false);

  // Anche marcandolo a mano come editoriale: l'autore non e' somto_official.
  assert.equal(isServableOfficialPost({ ...userPost, isOfficialUpdate: true }), false);

  // E anche con l'autore giusto ma senza il flag: niente scorciatoie.
  assert.equal(
    isServableOfficialPost({ ...userPost, authorUid: "somto_official" }),
    false
  );

  // Post privati/amici: mai.
  assert.equal(
    isServableOfficialPost({ ...OFFICIAL_POST, visibility: "friends" }),
    false
  );
  assert.equal(
    isServableOfficialPost({ ...OFFICIAL_POST, visibility: "private" }),
    false
  );

  // Input degeneri.
  assert.equal(isServableOfficialPost(null), false);
  assert.equal(isServableOfficialPost(undefined), false);
  assert.equal(isServableOfficialPost("official"), false);
  assert.equal(isServableOfficialPost([OFFICIAL_POST]), false);
  // isOfficialUpdate truthy ma non true (stringa da import sporco).
  assert.equal(isServableOfficialPost({ ...OFFICIAL_POST, isOfficialUpdate: "true" }), false);
  // Senza slug non c'e' nemmeno una URL canonica da servire.
  assert.equal(
    isServableOfficialPost({ ...OFFICIAL_POST, officialUpdate: { title: "x" } }),
    false
  );
});

test("il post editoriale e' servibile", () => {
  assert.equal(isServableOfficialPost(OFFICIAL_POST), true);
});

// --- slug e URL -------------------------------------------------------------

test("normalizeSlug accetta solo slug prodotti da slugify", () => {
  assert.equal(normalizeSlug("insidious-al-cinema"), "insidious-al-cinema");
  // Il post id deterministico e' accettato e ridotto a slug.
  assert.equal(normalizeSlug("official_insidious-al-cinema"), "insidious-al-cinema");
  assert.equal(normalizeSlug("Insidious-Al-Cinema"), "insidious-al-cinema");
  // Tutto cio' che potrebbe diventare un doc path strano viene rifiutato.
  assert.equal(normalizeSlug("../users/abc"), "");
  assert.equal(normalizeSlug("posts/abc"), "");
  assert.equal(normalizeSlug("abc def"), "");
  assert.equal(normalizeSlug("-abc"), "");
  assert.equal(normalizeSlug(""), "");
  assert.equal(normalizeSlug(null), "");
});

test("readSlugParam legge path e query", () => {
  assert.equal(
    readSlugParam({ path: "/novita/insidious-al-cinema", query: {} }),
    "insidious-al-cinema"
  );
  assert.equal(
    readSlugParam({ path: "/novita/insidious%20al%20cinema", query: {} }),
    ""
  );
  assert.equal(readSlugParam({ path: "/novita/", query: {} }), "");
  assert.equal(readSlugParam({ path: "/novita", query: {} }), "");
  assert.equal(
    readSlugParam({ path: "/novita/x", query: { slug: "official_altro-slug" } }),
    "altro-slug"
  );
  assert.equal(readSlugParam({}), "");
});

test("officialPostIdForSlug e buildOfficialUpdateUrl sono deterministici", () => {
  assert.equal(
    officialPostIdForSlug("insidious-al-cinema"),
    "official_insidious-al-cinema"
  );
  assert.equal(officialPostIdForSlug("../evil"), "");
  assert.equal(
    buildOfficialUpdateUrl("insidious-al-cinema"),
    "https://somto.it/novita/insidious-al-cinema"
  );
  // L'id completo del post porta comunque alla URL pubblica giusta.
  assert.equal(
    buildOfficialUpdateUrl("official_insidious-al-cinema"),
    "https://somto.it/novita/insidious-al-cinema"
  );
  assert.equal(buildOfficialUpdateUrl("posts/abc"), "");
});

// --- rendering --------------------------------------------------------------

test("paragraphsHtml escapa e spezza in paragrafi", () => {
  const html = paragraphsHtml("Riga uno\nRiga due\n\n<script>alert(1)</script>");
  assert.match(html, /Riga uno<br>Riga due/);
  assert.ok(!html.includes("<script>"));
  assert.match(html, /&lt;script&gt;/);
  assert.equal(html.split("<p class=\"nv-p\">").length - 1, 2);
});

test("la pagina espone og:/twitter:/canonical ed e' indicizzabile", () => {
  const html = renderOfficialUpdatePage("official_insidious-al-cinema-il-19-agosto", OFFICIAL_POST, [
    {
      titleId: "insidious-2010",
      name: "Insidious",
      year: 2010,
      posterPath: "https://image.tmdb.org/t/p/w300/x.jpg",
      type: "movie",
      href: "/film/insidious-2010",
    },
  ]);

  assert.match(
    html,
    /<link rel="canonical" href="https:\/\/somto\.it\/novita\/insidious-al-cinema-il-19-agosto">/
  );
  assert.match(html, /<meta property="og:type" content="article">/);
  assert.match(html, /<meta property="og:title" content="Insidious esce al cinema il 19 agosto">/);
  assert.match(html, /<meta property="og:description" content="La data ufficiale è arrivata\.">/);
  assert.match(html, /<meta property="og:image" content="https:\/\/image\.tmdb\.org/);
  assert.match(
    html,
    /<meta property="og:url" content="https:\/\/somto\.it\/novita\/insidious-al-cinema-il-19-agosto">/
  );
  assert.match(html, /<meta name="twitter:card" content="summary_large_image">/);
  assert.ok(!/name="robots" content="noindex"/.test(html));
  assert.match(html, /name="robots" content="index,follow/);
  // Titolo collegato linkato alla pagina pubblica gia' esistente.
  assert.match(html, /href="\/film\/insidious-2010"/);
  // Etichetta del tipo di aggiornamento, come nella console admin.
  assert.match(html, /Data di uscita/);
  // CTA verso l'app.
  assert.match(html, /community\.html\?post=official_insidious-al-cinema-il-19-agosto/);
  // Fonte esterna resa non seguibile.
  assert.match(html, /rel="nofollow noopener external"/);
});

test("il rendering escapa i campi editoriali", () => {
  const html = renderOfficialUpdatePage("official_x", {
    ...OFFICIAL_POST,
    text: "<img src=x onerror=alert(1)>",
    officialUpdate: {
      ...OFFICIAL_POST.officialUpdate,
      slug: "x",
      title: '"><script>alert(1)</script>',
      summary: "<b>bold</b>",
    },
  }, []);

  assert.ok(!html.includes("<script>alert(1)</script>"));
  assert.ok(!html.includes("<img src=x onerror"));
  assert.ok(!html.includes("<b>bold</b>"));
  assert.match(html, /&lt;script&gt;/);
});

// --- handler ----------------------------------------------------------------
//
// Stessa verifica del gate, ma passando dalla function registrata: e' quella
// che risponde in produzione, ed e' li' che un post utente deve morire.

const HANDLER_DOCS = {
  "posts/official_insidious": {
    ...OFFICIAL_POST,
    officialUpdate: { ...OFFICIAL_POST.officialUpdate, slug: "insidious" },
  },
  "posts/official_post-utente": {
    authorUid: "uid-utente",
    authorName: "Paolo",
    text: "Post di un utente vero",
    visibility: "public",
    kind: "post",
  },
  "titles/insidious-2010": {
    name: "Insidious",
    year: 2010,
    status: "approved",
    type: "movie",
    slug: "insidious-2010",
    posterPath: "https://image.tmdb.org/t/p/w300/x.jpg",
  },
};

function fakeDb() {
  const docRef = (path) => ({
    id: path.split("/").pop(),
    path,
    get: async () => ({
      exists: !!HANDLER_DOCS[path],
      id: path.split("/").pop(),
      data: () => HANDLER_DOCS[path],
    }),
  });
  return {
    collection: (name) => ({ doc: (id) => docRef(`${name}/${id}`) }),
    getAll: async (...refs) => refs.map((ref) => ({
      exists: !!HANDLER_DOCS[ref.path],
      id: ref.id,
      data: () => HANDLER_DOCS[ref.path],
    })),
  };
}

async function callHandler(path) {
  // `admin.firestore` e' una property con getter: serve defineProperty.
  const original = Object.getOwnPropertyDescriptor(admin, "firestore");
  Object.defineProperty(admin, "firestore", {
    value: () => fakeDb(), configurable: true, writable: true,
  });
  try {
    const registered = {};
    registerOfficialUpdatePage(registered);
    const res = { statusCode: 0, body: "", headers: {} };
    let resolveSent;
    const sent = new Promise((resolve) => { resolveSent = resolve; });
    res.set = (k, v) => { res.headers[k] = v; return res; };
    res.status = (code) => { res.statusCode = code; return res; };
    res.send = (body) => { res.body = String(body == null ? "" : body); resolveSent(); return res; };
    await registered.officialUpdatePage({ path, query: {}, method: "GET", headers: {} }, res);
    await sent;
    return res;
  } finally {
    if (original) Object.defineProperty(admin, "firestore", original);
  }
}

test("handler: il post editoriale risponde 200 con i tag di anteprima", async () => {
  const res = await callHandler("/novita/insidious");
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /<meta property="og:title"/);
  assert.match(res.body, /<link rel="canonical" href="https:\/\/somto\.it\/novita\/insidious">/);
});

test("handler: un post utente risponde 404, identico a uno slug inesistente", async () => {
  const userPost = await callHandler("/novita/post-utente");
  const missing = await callHandler("/novita/non-esiste-proprio");
  assert.equal(userPost.statusCode, 404);
  assert.equal(missing.statusCode, 404);
  // Nessun indizio sull'esistenza del post: stessa pagina, stesso testo.
  assert.equal(userPost.body, missing.body);
  assert.match(userPost.body, /Aggiornamento non trovato/);
  assert.match(userPost.body, /noindex/);
  // Il testo del post utente non finisce mai nella risposta.
  assert.ok(!userPost.body.includes("Post di un utente vero"));
});

test("handler: slug malformato risponde 404 senza toccare Firestore", async () => {
  const res = await callHandler("/novita/..%2Fusers%2Fabc");
  assert.equal(res.statusCode, 404);
});

test("un titolo non approvato resta testo, senza link morto", () => {
  const html = renderOfficialUpdatePage("official_x", { ...OFFICIAL_POST, officialUpdate: { ...OFFICIAL_POST.officialUpdate, slug: "x" } }, [
    { titleId: "bozza", name: "Titolo in bozza", year: null, posterPath: null, type: "tv", href: "" },
  ]);
  assert.match(html, /Titolo in bozza/);
  assert.ok(!html.includes('href="/serie/bozza"'));
});
