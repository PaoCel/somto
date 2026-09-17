#!/usr/bin/env python3
"""Aggiorna i due file che raccontano lo stato delle release iOS.

Il numero di build lo passa `ios-release.sh` dopo averlo letto da App Store
Connect, non da project.yml: per mesi i numeri scritti a mano qui dentro non
sono mai esistiti su ASC (CFBundleVersion era hardcoded in Info.plist).

    docs/context/RELEASE_PROCESS.md   nuovo bullet in cima a "## Build / TestFlight"
    CLAUDE.md                         riga "Ultima build iOS"
"""

import argparse
import re
import sys
import textwrap
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RELEASE_DOC = ROOT / "docs" / "context" / "RELEASE_PROCESS.md"
CLAUDE_DOC = ROOT / "CLAUDE.md"
SECTION = "## Build / TestFlight"


def fail(message):
    print(f"[release-docs] BLOCCATO: {message}", file=sys.stderr)
    sys.exit(1)


def info(message):
    print(f"[release-docs] {message}", file=sys.stderr)


def update_release_process(args):
    text = RELEASE_DOC.read_text()
    if SECTION not in text:
        fail(f"sezione '{SECTION}' non trovata in {RELEASE_DOC.name}.")
    if f"`{args.build}`" in text:
        info(f"build {args.build} gia' documentata, salto {RELEASE_DOC.name}")
        return False

    bullet = (
        f"- **{args.date} — {args.marketing} build `{args.build}` (TestFlight) — "
        f"{args.title}** {args.body} Stato ASC alla verifica: `{args.state}`.\n\n"
    )

    head, _, tail = text.partition(SECTION)
    tail = tail.lstrip("\n")
    RELEASE_DOC.write_text(f"{head}{SECTION}\n\n{bullet}{tail}")
    info(f"{RELEASE_DOC.name}: aggiunto bullet per {args.build}")
    return True


def update_claude(args):
    text = CLAUDE_DOC.read_text()
    lines = text.splitlines(keepends=True)

    start = next(
        (i for i, line in enumerate(lines) if line.startswith("- Ultima build iOS:")),
        None,
    )
    if start is None:
        fail("riga '- Ultima build iOS:' non trovata in CLAUDE.md.")

    end = start + 1
    while end < len(lines) and not lines[end].startswith("- "):
        end += 1

    live = f" La **{args.live}** resta live su App Store." if args.live else ""
    title = args.title if args.title.endswith(".") else f"{args.title}."
    block = (
        textwrap.fill(
            f"- Ultima build iOS: **{args.marketing} `{args.build}`** — caricata su "
            f"**TestFlight** il {args.date} (stato ASC `{args.state}`). {title}{live} "
            "Dettagli e regole di numerazione in `docs/context/RELEASE_PROCESS.md`.",
            width=79,
            subsequent_indent="  ",
            break_long_words=False,
            break_on_hyphens=False,
        )
        + "\n"
    )

    if "".join(lines[start:end]) == block:
        info("CLAUDE.md gia' aggiornato")
        return False

    CLAUDE_DOC.write_text("".join(lines[:start]) + block + "".join(lines[end:]))
    info(f"CLAUDE.md: stato corrente su {args.marketing} {args.build}")
    return True


def main():
    parser = argparse.ArgumentParser(prog="ios-release-docs.py", description=__doc__)
    parser.add_argument("--marketing", required=True)
    parser.add_argument("--build", required=True)
    parser.add_argument("--date", required=True, help="YYYY-MM-DD")
    parser.add_argument("--state", required=True, help="processingState letto da ASC")
    parser.add_argument("--title", required=True, help="titolo breve della build")
    parser.add_argument("--body", default="", help="prosa: cosa cambia per l'utente")
    parser.add_argument("--live", default="", help="versione pubblica attuale")
    args = parser.parse_args()

    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", args.date):
        fail(f"data non valida: {args.date}")

    changed = update_release_process(args)
    changed |= update_claude(args)
    if not changed:
        info("niente da aggiornare")


if __name__ == "__main__":
    main()
