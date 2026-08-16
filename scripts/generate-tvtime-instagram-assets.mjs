#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import satori from "satori";
import { Resvg } from "@resvg/resvg-js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const outDir = path.join(repoRoot, "design", "marketing", "tv-time-export-instagram");
const logoPath = path.join(repoRoot, "public", "icons", "somto-wordmark.png");

const colors = {
  bg: "#0A0A0A",
  panel: "#080508",
  line: "#342331",
  text: "#F8F8F8",
  muted: "#D8D8D8",
  pink: "#E91E63",
  purple: "#9C27B0",
  orange: "#F77737",
  gold: "#FFD166",
};

let somtoLogoSrc = "";

const fontPaths = [
  "/System/Library/Fonts/Supplemental/Arial.ttf",
  "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
  "/System/Library/Fonts/Supplemental/Arial Black.ttf",
];

async function loadFonts() {
  const [regular, bold, black] = await Promise.all(fontPaths.map((p) => fs.readFile(p)));
  return [
    { name: "SomtoSans", data: regular, weight: 400, style: "normal" },
    { name: "SomtoSans", data: bold, weight: 700, style: "normal" },
    { name: "SomtoSans", data: black, weight: 900, style: "normal" },
  ];
}

async function loadAssets() {
  const logo = await fs.readFile(logoPath);
  somtoLogoSrc = `data:image/png;base64,${logo.toString("base64")}`;
}

function brandHeader({ label = "SOMTO", size = 46 } = {}) {
  const logoWidth = Math.round(size * 3.25);
  const logoHeight = Math.round(size * 1.1);
  return {
    type: "div",
    props: {
      style: { display: "flex", alignItems: "center", gap: 18 },
      children: [
        {
          type: "div",
          props: {
            style: {
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "9px 14px",
              borderRadius: 18,
              background: "#FFFFFF",
              border: "1px solid rgba(255,255,255,0.72)",
              boxShadow: "0 12px 36px rgba(0,0,0,0.34)",
            },
            children: {
              type: "img",
              props: {
                src: somtoLogoSrc,
                style: {
                  width: logoWidth,
                  height: logoHeight,
                  objectFit: "contain",
                },
              },
            },
          },
        },
        {
          type: "div",
          props: {
            style: {
              width: 5,
              height: size * 0.72,
              borderRadius: 8,
              background: `linear-gradient(180deg, ${colors.orange}, ${colors.pink}, ${colors.purple})`,
            },
          },
        },
        {
          type: "div",
          props: {
            style: {
              fontSize: Math.max(18, size * 0.34),
              color: "#EFEFEF",
              fontWeight: 700,
              letterSpacing: "0.18em",
            },
            children: label,
          },
        },
      ],
    },
  };
}

function bg(width, height) {
  return [
    {
      type: "div",
      props: {
        style: {
          position: "absolute",
          inset: 0,
          background: `linear-gradient(145deg, #020202 0%, #070306 56%, #120815 100%)`,
        },
      },
    },
    {
      type: "div",
      props: {
        style: {
          position: "absolute",
          width: width * 0.8,
          height: width * 0.8,
          right: -width * 0.28,
          top: -width * 0.32,
          borderRadius: "50%",
          background: `radial-gradient(circle, rgba(233,30,99,0.34) 0%, rgba(156,39,176,0.22) 42%, transparent 72%)`,
        },
      },
    },
    {
      type: "div",
      props: {
        style: {
          position: "absolute",
          width: width * 0.72,
          height: width * 0.72,
          left: -width * 0.34,
          bottom: -width * 0.36,
          borderRadius: "50%",
          background: `radial-gradient(circle, rgba(247,119,55,0.30) 0%, rgba(233,30,99,0.18) 48%, transparent 74%)`,
        },
      },
    },
  ];
}

function paragraph(text, opts = {}) {
  return {
    type: "div",
    props: {
      style: {
        fontSize: opts.size || 42,
        lineHeight: opts.lineHeight || 1.22,
        fontWeight: opts.weight || 400,
        color: opts.color || colors.muted,
        maxWidth: opts.maxWidth || "100%",
        whiteSpace: "pre-wrap",
      },
      children: text,
    },
  };
}

function pill(text) {
  return {
    type: "div",
    props: {
      style: {
        display: "flex",
        alignItems: "center",
        alignSelf: "flex-start",
        padding: "14px 22px",
        borderRadius: 999,
        background: "#090609",
        border: `1px solid ${colors.line}`,
        color: colors.text,
        fontSize: 26,
        fontWeight: 700,
      },
      children: text,
    },
  };
}

function card(children, style = {}) {
  return {
    type: "div",
    props: {
      style: {
        display: "flex",
        flexDirection: "column",
        gap: 20,
        padding: 32,
        borderRadius: 28,
        background: colors.panel,
        border: `1px solid ${colors.line}`,
        ...style,
      },
      children,
    },
  };
}

function contentPanel(children, style = {}) {
  return {
    type: "div",
    props: {
      style: {
        display: "flex",
        flexDirection: "column",
        gap: 30,
        padding: 34,
        borderRadius: 26,
        background: "#050505",
        border: `1px solid ${colors.line}`,
        boxShadow: "0 24px 80px rgba(0,0,0,0.62)",
        ...style,
      },
      children,
    },
  };
}

function squareSlide({ number, kicker, title, body, footer = "somto.it/blog", accent = colors.pink }) {
  const width = 1080;
  const height = 1080;
  return {
    type: "div",
    props: {
      style: {
        width,
        height,
        position: "relative",
        display: "flex",
        flexDirection: "column",
        padding: 70,
        overflow: "hidden",
        fontFamily: "SomtoSans, Arial, sans-serif",
        color: colors.text,
      },
      children: [
        ...bg(width, height),
        {
          type: "div",
          props: {
            style: {
              position: "relative",
              display: "flex",
              flexDirection: "column",
              height: "100%",
            },
            children: [
              {
                type: "div",
                props: {
                  style: { display: "flex", justifyContent: "space-between", alignItems: "center" },
                  children: [
                    brandHeader({ label: "TV TIME" }),
                    pill(`${number}/6`),
                  ],
                },
              },
              {
                type: "div",
                props: {
                  style: {
                    display: "flex",
                    flexDirection: "column",
                    justifyContent: "center",
                    flex: 1,
                  },
                  children: [
                    contentPanel([
                      paragraph(kicker.toUpperCase(), {
                        size: 28,
                        weight: 700,
                        color: accent,
                      }),
                      paragraph(title, {
                        size: 74,
                        weight: 900,
                        color: colors.text,
                        lineHeight: 1.06,
                      }),
                      paragraph(body, {
                        size: 38,
                        color: colors.muted,
                        maxWidth: 870,
                        lineHeight: 1.26,
                      }),
                    ]),
                  ],
                },
              },
              {
                type: "div",
                props: {
                  style: {
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    borderTop: `1px solid ${colors.line}`,
                    paddingTop: 26,
                  },
                  children: [
                    paragraph(footer, { size: 28, weight: 700, color: colors.text }),
                    {
                      type: "div",
                      props: {
                        style: {
                          display: "flex",
                          width: 144,
                          height: 8,
                          borderRadius: 999,
                          background: `linear-gradient(90deg, ${colors.orange}, ${colors.pink}, ${colors.purple})`,
                        },
                      },
                    },
                  ],
                },
              },
            ],
          },
        },
      ],
    },
  };
}

function storySlide({ kicker, title, body, cta }) {
  const width = 1080;
  const height = 1920;
  return {
    type: "div",
    props: {
      style: {
        width,
        height,
        position: "relative",
        display: "flex",
        flexDirection: "column",
        padding: "96px 72px",
        overflow: "hidden",
        fontFamily: "SomtoSans, Arial, sans-serif",
        color: colors.text,
      },
      children: [
        ...bg(width, height),
        {
          type: "div",
          props: {
            style: {
              position: "relative",
              height: "100%",
              display: "flex",
              flexDirection: "column",
            },
            children: [
              brandHeader({ label: "PROMEMORIA", size: 52 }),
              {
                type: "div",
                props: {
                  style: { display: "flex", flexDirection: "column", justifyContent: "center", flex: 1 },
                  children: [
                    contentPanel([
                      pill(kicker),
                      paragraph(title, { size: 92, weight: 900, color: colors.text, lineHeight: 1.04 }),
                      paragraph(body, { size: 44, color: colors.muted, lineHeight: 1.24 }),
                    ], { gap: 36, padding: 40 }),
                  ],
                },
              },
              card([
                paragraph(cta, { size: 34, weight: 700, color: colors.text }),
                paragraph("somto.it/blog", { size: 30, color: colors.muted }),
              ]),
            ],
          },
        },
      ],
    },
  };
}

await loadAssets();

const carousel = [
  ["carousel-01-cover.png", squareSlide({
    number: 1,
    kicker: "Urgente",
    title: "TV Time chiude\nil 15 luglio 2026",
    body: "Se lo usavi per segnare film, serie ed episodi, salva subito i tuoi dati.",
    accent: colors.gold,
  })],
  ["carousel-02-export.png", squareSlide({
    number: 2,
    kicker: "Prima cosa",
    title: "Esporta la\ncronologia",
    body: "Non devi scegliere oggi la nuova app. Devi prima scaricare il file.",
    accent: colors.orange,
  })],
  ["carousel-03-tool.png", squareSlide({
    number: 3,
    kicker: "Tool ufficiale",
    title: "Vai sul portale\nGDPR di TV Time",
    body: "Apri gdpr.tvtime.com/gdpr/self-service, accedi e richiedi l'export.",
    accent: colors.pink,
  })],
  ["carousel-04-check.png", squareSlide({
    number: 4,
    kicker: "Dopo il download",
    title: "Controlla\nil file",
    body: "Apri lo zip, verifica che non sia vuoto e cerca file .json o .csv.",
    accent: colors.purple,
  })],
  ["carousel-05-backup.png", squareSlide({
    number: 5,
    kicker: "Backup",
    title: "Fanne\ndue copie",
    body: "Una su cloud, una locale. Non caricarlo su strumenti di cui non ti fidi.",
    accent: colors.orange,
  })],
  ["carousel-06-somto.png", squareSlide({
    number: 6,
    kicker: "Dopo",
    title: "Rimetti tutto\nin ordine",
    body: "Su Somto puoi tracciare film e serie, votare, creare watchlist e seguire gli amici.",
    footer: "somto.it",
    accent: colors.pink,
  })],
];

const stories = [
  ["story-01-reminder.png", storySlide({
    kicker: "TV Time",
    title: "Salva i tuoi dati\nprima del 15 luglio",
    body: "Se hai anni di episodi, film e watchlist, esporta subito la cronologia.",
    cta: "Guida rapida sul blog di Somto",
  })],
  ["story-02-steps.png", storySlide({
    kicker: "3 passaggi",
    title: "Export,\ndownload,\nbackup",
    body: "Richiedi il file, controlla lo zip e tienine una copia al sicuro.",
    cta: "Apri la guida completa",
  })],
  ["story-03-cta.png", storySlide({
    kicker: "Somto",
    title: "Poi scegli\ndove ricominciare",
    body: "Watchlist, voti, film, serie TV e amici in un'unica app.",
    cta: "Link sticker: somto.it/blog/come-esportare-dati-tv-time/",
  })],
];

async function renderPng(fileName, tree, fonts) {
  const svg = await satori(tree, {
    width: tree.props.style.width,
    height: tree.props.style.height,
    fonts,
  });
  const png = new Resvg(svg, {
    fitTo: { mode: "width", value: tree.props.style.width },
  }).render().asPng();
  await fs.writeFile(path.join(outDir, fileName), png);
  console.log(`✓ ${fileName}`);
}

await fs.mkdir(outDir, { recursive: true });
const fonts = await loadFonts();
for (const [fileName, tree] of [...carousel, ...stories]) {
  await renderPng(fileName, tree, fonts);
}
