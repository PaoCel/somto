#!/usr/bin/env bash
# Somto — gate di qualita' iOS.
#
# Fonte di verita' UNICA per i controlli iOS: la usano l'hook pre-push, la CI
# e il rilascio. Se un controllo va aggiunto, va aggiunto qui, non in tre posti.
#
#   scripts/ios-ci.sh              # fast  (default) — hook pre-push
#   scripts/ios-ci.sh --full       # + build Release + test — pre-rilascio / CI
#   scripts/ios-ci.sh --lint-only  # solo lint + footgun, nessun compilatore
#
# fast:      xcodegen · swiftlint · footgun · build Debug
# full:      fast + build Release + xcodebuild test
#
# Perche' la build RELEASE e' separata e obbligatoria prima di rilasciare:
# un helper che finisce dentro il `#if DEBUG` dei #Preview compila in Debug e
# rompe in Release. E' gia' costato una release (vedi docs/IOS_REFACTOR_PLAN.md
# §2.4). Debug verde non dice niente sulla Release.

set -uo pipefail

cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"
IOS_DIR="${REPO_ROOT}/ios"

MODE="fast"
case "${1:-}" in
  --full)      MODE="full" ;;
  --lint-only) MODE="lint" ;;
  --fast|"")   MODE="fast" ;;
  *) echo "Uso: $0 [--fast|--full|--lint-only]" >&2; exit 2 ;;
esac

DERIVED="${SOMTO_IOS_DERIVED_DATA:-${IOS_DIR}/build/ci-derived-data}"

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
yellow(){ printf '\033[33m%s\033[0m\n' "$*"; }
blue()  { printf '\033[34m▸ %s\033[0m\n' "$*"; }

failures=0
step_failed() { red "  ✗ $1"; failures=$((failures + 1)); }

# --------------------------------------------------------------------------
# 1. Footgun Swift (allowlist doc-id) — condiviso con l'hook pre-commit.
# --------------------------------------------------------------------------
blue "Footgun Swift"
if command -v node >/dev/null 2>&1; then
  node "${REPO_ROOT}/scripts/check-swift-footguns.mjs" || step_failed "footgun Swift"
else
  red "  node assente: controllo saltato"
fi

# --------------------------------------------------------------------------
# 2. SwiftLint — configurazione ratchet in ios/.swiftlint.yml.
#    Le soglie sono sopra lo stato attuale: un fallimento qui significa
#    "hai peggiorato", non "il codice e' sporco".
# --------------------------------------------------------------------------
blue "SwiftLint"
# Baseline misurata su 7bb33c0 (2026-08-08). Ogni fase del refactoring la fa
# scendere: se sale, qualcosa e' peggiorato e va guardato prima di pushare.
SWIFTLINT_BASELINE=18
if command -v swiftlint >/dev/null 2>&1; then
  lint_out="$(mktemp)"
  # `lint` esce != 0 solo sulle violazioni di severita' error.
  (cd "${IOS_DIR}" && swiftlint lint --quiet) > "${lint_out}" 2>&1 \
    || step_failed "SwiftLint (violazioni error)"

  warn_count=$(grep -c " warning: " "${lint_out}" || true)
  # Riepilogo per regola: 18 righe di dettaglio a ogni push non le legge nessuno.
  grep -oE '\(\w+\)$' "${lint_out}" | sort | uniq -c | sort -rn | sed 's/^/    /'

  if [ "${warn_count}" -gt "${SWIFTLINT_BASELINE}" ]; then
    red "  warning: ${warn_count} — SALITI rispetto al baseline ${SWIFTLINT_BASELINE}"
    grep " warning: " "${lint_out}" | head -20
    step_failed "SwiftLint sopra baseline"
  else
    echo "  warning: ${warn_count} / baseline ${SWIFTLINT_BASELINE}"
    if [ "${warn_count}" -lt "${SWIFTLINT_BASELINE}" ]; then
      green "  baseline superata: aggiorna SWIFTLINT_BASELINE a ${warn_count} in questo script"
    fi
  fi
  rm -f "${lint_out}"
else
  red "  swiftlint assente — installa con: brew install swiftlint"
  [ "${MODE}" = "lint" ] && step_failed "swiftlint assente"
fi

if [ "${MODE}" = "lint" ]; then
  [ "${failures}" -eq 0 ] && green "OK (solo lint)." || red "${failures} controllo/i falliti."
  exit "${failures}"
fi

# --------------------------------------------------------------------------
# 3. Spazio su disco.
#
# Una build Debug+Release+test riempie ~5 GB di DerivedData. Senza questo
# controllo il disco pieno arriva travestito da errore del compilatore
# ("unable to open output file ... No space left on device"), che manda a
# cercare un problema di codice che non esiste. E' successo il 2026-08-08.
# --------------------------------------------------------------------------
# La soglia dipende dalla modalita': `--fast` compila solo Debug e riusa la
# DerivedData esistente, `--full` aggiunge Release + test e la fa quasi
# raddoppiare. Una soglia unica al valore alto bloccherebbe push legittimi.
if [ "${MODE}" = "full" ]; then
  REQUIRED_GB=8
else
  REQUIRED_GB=3
fi
# Si misura il volume dove vive la DERIVED DATA, non quello del repo: sono la
# stessa cosa solo finche' si usa il percorso di default. Con
# `SOMTO_IOS_DERIVED_DATA` che punta a un disco esterno, misurare `${IOS_DIR}`
# bloccava una build che aveva decine di GB a disposizione.
mkdir -p "${DERIVED}" 2>/dev/null || true
avail_gb=$(df -g "${DERIVED}" 2>/dev/null | awk 'NR==2 {print $4}')
if [ "${avail_gb:-0}" -lt "${REQUIRED_GB}" ]; then
  red "Spazio insufficiente su ${DERIVED}: ${avail_gb} GB liberi, ne servono ~${REQUIRED_GB}."
  yellow "  la DerivedData del gate sta in ${DERIVED}"
  yellow "  liberala con: rm -rf '${DERIVED}'"
  yellow "  (si rigenera da sola; la run successiva sara' a freddo)"
  exit 1
fi

# --------------------------------------------------------------------------
# 4. Progetto rigenerato da project.yml.
#    Il .xcodeproj e' versionato ma derivato: se diverge, la build locale e
#    quella di rilascio non compilano le stesse sorgenti.
# --------------------------------------------------------------------------
#    Si rigenera SOLO quando serve. Rigenerare sempre riscrive il .xcodeproj a
#    ogni run e INVALIDA la build incrementale: il gate pre-push passava da ~1
#    minuto a una build completa ogni volta, che e' il modo piu' rapido per far
#    disattivare l'hook.
#
#    "Quando serve" e' DUE condizioni, non una:
#      a) project.yml piu' recente del .xcodeproj (impostazioni cambiate);
#      b) l'ELENCO dei sorgenti e' cambiato (file aggiunto/rimosso/rinominato).
#    La (b) non e' deducibile dalle date: XcodeGen prende i file per cartella,
#    ma il .xcodeproj li elenca uno per uno, e aggiungere un .swift NON tocca
#    project.yml. Con la sola (a) il gate avrebbe compilato un progetto
#    stantio senza dirlo — peggio che non avere il gate.
blue "XcodeGen"
if command -v xcodegen >/dev/null 2>&1; then
  PBXPROJ="${IOS_DIR}/TwoWatch.xcodeproj/project.pbxproj"
  SOURCES_STAMP="${IOS_DIR}/build/.xcodegen-sources-stamp"
  current_sources="$(cd "${IOS_DIR}" && find TwoWatch TwoWatchTests SomtoWidgets -name '*.swift' | sort | shasum | cut -d' ' -f1)"
  previous_sources="$(cat "${SOURCES_STAMP}" 2>/dev/null || true)"

  needs_regen=0
  reason=""
  if [ ! -f "${PBXPROJ}" ]; then
    needs_regen=1; reason="progetto assente"
  elif [ "${IOS_DIR}/project.yml" -nt "${PBXPROJ}" ]; then
    needs_regen=1; reason="project.yml e' cambiato"
  elif [ "${current_sources}" != "${previous_sources}" ]; then
    needs_regen=1; reason="l'elenco dei sorgenti e' cambiato"
  fi

  if [ "${needs_regen}" -eq 1 ]; then
    echo "  ${reason}: rigenero"
    if (cd "${IOS_DIR}" && xcodegen generate --quiet); then
      mkdir -p "$(dirname "${SOURCES_STAMP}")"
      printf '%s' "${current_sources}" > "${SOURCES_STAMP}"
    else
      step_failed "xcodegen generate"
    fi
  else
    echo "  progetto gia' allineato"
  fi
else
  red "  xcodegen assente — installa con: brew install xcodegen"
  step_failed "xcodegen assente"
fi

# Destination.
#
# Per `build` si usa `generic/platform=iOS Simulator`: compila senza pretendere
# che un simulatore CONCRETO esista, quindi non si rompe quando cambia il set di
# runtime installati (e' successo: "iPhone 16" hardcoded esiste solo sul runtime
# 18.5 di questa macchina, e xcodebuild rispondeva "Unable to find a device
# matching the provided destination specifier").
#
# Per `test` serve invece un device vero: si risolve a runtime, stessa logica di
# scripts/ios-release.sh. SOMTO_IOS_SIMULATOR forza un nome specifico.
BUILD_DESTINATION="generic/platform=iOS Simulator"

resolve_test_destination() {
  if [ -n "${SOMTO_IOS_SIMULATOR:-}" ]; then
    echo "platform=iOS Simulator,name=${SOMTO_IOS_SIMULATOR}"
    return 0
  fi
  local udid
  udid="$(xcrun simctl list devices available --json 2>/dev/null \
    | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(1)
best = None
for runtime, devices in data.get("devices", {}).items():
    if "iOS" not in runtime:
        continue
    for device in devices:
        if device.get("name", "").startswith("iPhone"):
            best = device["udid"]
print(best or "")
')"
  [ -n "${udid}" ] || return 1
  echo "platform=iOS Simulator,id=${udid}"
}

run_xcodebuild() {
  local label="$1"; local destination="$2"; shift 2
  blue "${label}"
  local log; log="$(mktemp)"
  if xcodebuild "$@" \
      -project "${IOS_DIR}/TwoWatch.xcodeproj" \
      -scheme TwoWatch \
      -destination "${destination}" \
      -derivedDataPath "${DERIVED}" \
      CODE_SIGNING_ALLOWED=NO \
      > "${log}" 2>&1; then
    local warnings; warnings=$(grep -c " warning: " "${log}" || true)
    echo "  warning di compilazione: ${warnings}"
    rm -f "${log}"
    return 0
  fi
  red "  --- errori ---"
  grep -E " error: |^error: |xcodebuild: error:" "${log}" | head -25
  echo "  log completo: ${log}"
  step_failed "${label}"
  return 1
}

run_xcodebuild "Build Debug" "${BUILD_DESTINATION}" build -configuration Debug

if [ "${MODE}" = "full" ]; then
  # L'unico controllo che intercetta il footgun #if DEBUG + #Preview.
  run_xcodebuild "Build Release" "${BUILD_DESTINATION}" build -configuration Release

  if test_destination="$(resolve_test_destination)"; then
    run_xcodebuild "Test" "${test_destination}" test -configuration Debug
  else
    red "  nessun simulatore iPhone disponibile: test saltati"
    step_failed "Test (nessun simulatore)"
  fi
fi

echo
if [ "${failures}" -eq 0 ]; then
  green "iOS OK (${MODE})."
  exit 0
fi
red "${failures} controllo/i falliti."
exit 1
