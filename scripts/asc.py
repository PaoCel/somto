#!/usr/bin/env python3
"""Client App Store Connect per il flusso di rilascio iOS.

Serve a togliere dal rilascio i due punti ciechi storici: il numero di build
scelto a mano (un valore gia' consumato viene rifiutato all'upload) e il
"Uploaded TwoWatch" di xcodebuild, che dice solo che il pacchetto e' partito,
non che App Store Connect l'abbia accettato.

Credenziali, in ordine di precedenza: variabili d'ambiente ASC_*, poi
~/.appstoreconnect/config.json. La chiave .p8 non sta e non deve stare in repo.

Uso:
    asc.py check                      verifica credenziali e accesso
    asc.py builds [--limit N]         ultime build su ASC
    asc.py next-build                 prossimo CURRENT_PROJECT_VERSION libero
    asc.py wait-build <n> [--timeout] attende che la build compaia ed esca da PROCESSING
    asc.py live-version               versione pubblica attuale sullo Store
    asc.py submit --marketing X.Y.Z --build N --notes-file f.json
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

try:
    import jwt
except ImportError:
    sys.exit("[asc] manca PyJWT: pip3 install pyjwt cryptography")

API = "https://api.appstoreconnect.apple.com"
CONFIG_PATH = Path.home() / ".appstoreconnect" / "config.json"
PLATFORM = "IOS"


def fail(message):
    print(f"[asc] BLOCCATO: {message}", file=sys.stderr)
    sys.exit(1)


def info(message):
    print(f"[asc] {message}", file=sys.stderr)


# --- credenziali ------------------------------------------------------------

def load_config():
    cfg = {}
    if CONFIG_PATH.exists():
        try:
            cfg = json.loads(CONFIG_PATH.read_text())
        except json.JSONDecodeError as exc:
            fail(f"{CONFIG_PATH} non e' JSON valido: {exc}")

    resolved = {
        "key_id": os.environ.get("ASC_KEY_ID") or cfg.get("key_id"),
        "issuer_id": os.environ.get("ASC_ISSUER_ID") or cfg.get("issuer_id"),
        "app_id": os.environ.get("ASC_APP_ID") or cfg.get("app_id"),
        "key_path": os.environ.get("ASC_KEY_PATH") or cfg.get("key_path"),
    }

    missing = [k for k, v in resolved.items() if not v]
    if missing:
        fail(
            f"credenziali incomplete ({', '.join(missing)}). "
            f"Compila {CONFIG_PATH} oppure esporta ASC_KEY_ID/ASC_ISSUER_ID/ASC_APP_ID/ASC_KEY_PATH."
        )

    resolved["key_path"] = str(Path(resolved["key_path"]).expanduser())
    if not Path(resolved["key_path"]).exists():
        fail(f"chiave privata non trovata: {resolved['key_path']}")

    mode = Path(resolved["key_path"]).stat().st_mode & 0o077
    if mode:
        info(f"ATTENZIONE: {resolved['key_path']} e' leggibile da altri utenti. chmod 600 consigliato.")

    return resolved


def token(cfg):
    now = int(time.time())
    payload = {
        "iss": cfg["issuer_id"],
        "iat": now,
        "exp": now + 900,
        "aud": "appstoreconnect-v1",
    }
    key = Path(cfg["key_path"]).read_text()
    return jwt.encode(payload, key, algorithm="ES256", headers={"kid": cfg["key_id"], "typ": "JWT"})


def request(cfg, method, path, body=None, params=None):
    url = f"{API}{path}"
    if params:
        pairs = []
        for key, value in params.items():
            if isinstance(value, (list, tuple)):
                value = ",".join(str(v) for v in value)
            pairs.append(f"{key}={urllib.parse.quote(str(value), safe=',')}")
        url = f"{url}?{'&'.join(pairs)}"

    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {token(cfg)}")
    if data:
        req.add_header("Content-Type", "application/json")

    try:
        with urllib.request.urlopen(req) as response:
            raw = response.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors="replace")
        try:
            errors = json.loads(detail).get("errors", [])
            detail = "; ".join(
                f"{e.get('title', '?')}: {e.get('detail', '')}" for e in errors
            ) or detail
        except json.JSONDecodeError:
            pass
        fail(f"{method} {path} -> HTTP {exc.code}: {detail}")
    except urllib.error.URLError as exc:
        fail(f"{method} {path} irraggiungibile: {exc.reason}")


# --- letture ----------------------------------------------------------------

def fetch_builds(cfg, limit=10):
    payload = request(
        cfg,
        "GET",
        "/v1/builds",
        params={
            "filter[app]": cfg["app_id"],
            "limit": limit,
            "sort": "-version",
            "fields[builds]": "version,uploadedDate,processingState,expired",
        },
    )
    return payload.get("data", [])


def find_build(cfg, version):
    payload = request(
        cfg,
        "GET",
        "/v1/builds",
        params={
            "filter[app]": cfg["app_id"],
            "filter[version]": version,
            "limit": 1,
            "fields[builds]": "version,uploadedDate,processingState,expired",
        },
    )
    data = payload.get("data", [])
    return data[0] if data else None


def next_build_number(cfg, today=None):
    """YYYYMMDDNN, dove NN e' il primo progressivo libero della giornata.

    Il progressivo si calcola sulle build gia' su ASC, non su project.yml: e'
    ASC a rifiutare i duplicati, quindi e' ASC la fonte di verita'. Se la
    giornata e' vuota si riparte da 01.
    """
    day = today or datetime.now().strftime("%Y%m%d")
    used = set()
    for build in fetch_builds(cfg, limit=200):
        version = build["attributes"]["version"]
        if version.startswith(day) and len(version) == 10 and version.isdigit():
            used.add(int(version[8:]))

    for seq in range(1, 100):
        if seq not in used:
            return f"{day}{seq:02d}"
    fail(f"esauriti i 99 slot per il giorno {day}.")


def live_version(cfg):
    payload = request(
        cfg,
        "GET",
        f"/v1/apps/{cfg['app_id']}/appStoreVersions",
        params={
            "filter[appStoreState]": "READY_FOR_SALE",
            "limit": 1,
            "fields[appStoreVersions]": "versionString,appStoreState,createdDate",
        },
    )
    data = payload.get("data", [])
    return data[0]["attributes"]["versionString"] if data else None


def wait_for_build(cfg, version, timeout=1800, interval=30):
    """Attende che la build compaia su ASC e finisca l'elaborazione.

    Ritorna lo stato finale. Distingue tre esiti che il log di xcodebuild
    confonde: mai arrivata, arrivata e scartata, arrivata e valida.
    """
    deadline = time.time() + timeout
    seen = False
    while time.time() < deadline:
        build = find_build(cfg, version)
        if build:
            state = build["attributes"]["processingState"]
            if not seen:
                info(f"build {version} registrata su ASC (stato {state})")
                seen = True
            if state != "PROCESSING":
                return state
        time.sleep(interval)

    if not seen:
        fail(
            f"build {version} non e' mai comparsa su ASC entro {timeout}s. "
            "L'upload non e' andato a buon fine, qualunque cosa dica xcodebuild."
        )
    fail(f"build {version} ancora in PROCESSING dopo {timeout}s. Controlla su ASC.")


# --- invio in verifica ------------------------------------------------------

def get_or_create_version(cfg, marketing):
    payload = request(
        cfg,
        "GET",
        f"/v1/apps/{cfg['app_id']}/appStoreVersions",
        params={
            "filter[versionString]": marketing,
            "limit": 1,
            "fields[appStoreVersions]": "versionString,appStoreState",
        },
    )
    data = payload.get("data", [])
    if data:
        state = data[0]["attributes"]["appStoreState"]
        info(f"versione {marketing} gia' esistente (stato {state})")
        return data[0]["id"]

    info(f"creo la versione {marketing}")
    created = request(
        cfg,
        "POST",
        "/v1/appStoreVersions",
        body={
            "data": {
                "type": "appStoreVersions",
                "attributes": {"platform": PLATFORM, "versionString": marketing},
                "relationships": {
                    "app": {"data": {"type": "apps", "id": cfg["app_id"]}}
                },
            }
        },
    )
    return created["data"]["id"]


def attach_build(cfg, version_id, build_id):
    request(
        cfg,
        "PATCH",
        f"/v1/appStoreVersions/{version_id}/relationships/build",
        body={"data": {"type": "builds", "id": build_id}},
    )
    info("build allegata alla versione")


def set_release_notes(cfg, version_id, notes):
    """notes: {"it": "...", "en-US": "...", ...} sulle localizzazioni esistenti."""
    payload = request(
        cfg,
        "GET",
        f"/v1/appStoreVersions/{version_id}/appStoreVersionLocalizations",
        params={"limit": 50, "fields[appStoreVersionLocalizations]": "locale,whatsNew"},
    )
    by_locale = {loc["attributes"]["locale"]: loc["id"] for loc in payload.get("data", [])}

    for locale, text in notes.items():
        loc_id = by_locale.get(locale)
        if not loc_id:
            info(f"ATTENZIONE: locale {locale} non presente su ASC, note ignorate")
            continue
        request(
            cfg,
            "PATCH",
            f"/v1/appStoreVersionLocalizations/{loc_id}",
            body={
                "data": {
                    "type": "appStoreVersionLocalizations",
                    "id": loc_id,
                    "attributes": {"whatsNew": text},
                }
            },
        )
        info(f"note di rilascio scritte per {locale}")


def submit_for_review(cfg, version_id):
    submission = request(
        cfg,
        "POST",
        "/v1/reviewSubmissions",
        body={
            "data": {
                "type": "reviewSubmissions",
                "attributes": {"platform": PLATFORM},
                "relationships": {
                    "app": {"data": {"type": "apps", "id": cfg["app_id"]}}
                },
            }
        },
    )
    submission_id = submission["data"]["id"]

    request(
        cfg,
        "POST",
        "/v1/reviewSubmissionItems",
        body={
            "data": {
                "type": "reviewSubmissionItems",
                "relationships": {
                    "reviewSubmission": {
                        "data": {"type": "reviewSubmissions", "id": submission_id}
                    },
                    "appStoreVersion": {
                        "data": {"type": "appStoreVersions", "id": version_id}
                    },
                },
            }
        },
    )

    request(
        cfg,
        "PATCH",
        f"/v1/reviewSubmissions/{submission_id}",
        body={
            "data": {
                "type": "reviewSubmissions",
                "id": submission_id,
                "attributes": {"submitted": True},
            }
        },
    )
    return submission_id


# --- comandi ----------------------------------------------------------------

def cmd_check(cfg, _args):
    builds = fetch_builds(cfg, limit=1)
    live = live_version(cfg)
    print(f"credenziali ok — key {cfg['key_id']}, app {cfg['app_id']}")
    print(f"versione pubblica sullo Store: {live or '(nessuna)'}")
    if builds:
        attrs = builds[0]["attributes"]
        print(f"ultima build: {attrs['version']} ({attrs['processingState']})")


def cmd_config_export(cfg, _args):
    """Credenziali risolte in forma eval-abile, per passarle a xcodebuild."""
    import shlex

    for key, value in cfg.items():
        print(f"ASC_{key.upper()}={shlex.quote(str(value))}")


def cmd_builds(cfg, args):
    for build in fetch_builds(cfg, limit=args.limit):
        attrs = build["attributes"]
        print(
            f"{attrs['version']:<12} {attrs['processingState']:<10} "
            f"{attrs['uploadedDate']} expired={attrs['expired']}"
        )


def cmd_next_build(cfg, _args):
    print(next_build_number(cfg))


def cmd_wait_build(cfg, args):
    state = wait_for_build(cfg, args.version, timeout=args.timeout)
    print(state)
    if state != "VALID":
        fail(f"build {args.version} in stato {state}, non VALID.")


def cmd_live_version(cfg, _args):
    print(live_version(cfg) or "")


def cmd_submit(cfg, args):
    """Invio in verifica: azione pubblica, richiede conferma esplicita."""
    if os.environ.get("CONFIRM_SUBMIT") != args.marketing:
        fail(
            f"invio in verifica di {args.marketing} non confermato. "
            f"Serve CONFIRM_SUBMIT={args.marketing} nell'ambiente."
        )

    build = find_build(cfg, args.build)
    if not build:
        fail(f"build {args.build} non trovata su ASC.")
    if build["attributes"]["processingState"] != "VALID":
        fail(f"build {args.build} in stato {build['attributes']['processingState']}, non allegabile.")

    live = live_version(cfg)
    info(f"pubblica attuale: {live or '(nessuna)'} → si invia {args.marketing}")

    version_id = get_or_create_version(cfg, args.marketing)
    attach_build(cfg, version_id, build["id"])

    if args.notes_file:
        notes = json.loads(Path(args.notes_file).read_text())
        set_release_notes(cfg, version_id, notes)

    submission_id = submit_for_review(cfg, version_id)
    print(f"inviata in verifica: {args.marketing} build {args.build} (submission {submission_id})")


def main():
    parser = argparse.ArgumentParser(prog="asc.py", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("check").set_defaults(func=cmd_check)
    sub.add_parser("config-export").set_defaults(func=cmd_config_export)

    p_builds = sub.add_parser("builds")
    p_builds.add_argument("--limit", type=int, default=10)
    p_builds.set_defaults(func=cmd_builds)

    sub.add_parser("next-build").set_defaults(func=cmd_next_build)

    p_wait = sub.add_parser("wait-build")
    p_wait.add_argument("version")
    p_wait.add_argument("--timeout", type=int, default=1800)
    p_wait.set_defaults(func=cmd_wait_build)

    sub.add_parser("live-version").set_defaults(func=cmd_live_version)

    p_submit = sub.add_parser("submit")
    p_submit.add_argument("--marketing", required=True)
    p_submit.add_argument("--build", required=True)
    p_submit.add_argument("--notes-file", help='JSON {"it": "...", "en-US": "..."}')
    p_submit.set_defaults(func=cmd_submit)

    args = parser.parse_args()
    args.func(load_config(), args)


if __name__ == "__main__":
    main()
