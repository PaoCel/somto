#!/usr/bin/env bash
#
# Rilascio iOS su TestFlight, dal working tree all'esito verificato su ASC.
#
#   preflight → numero build da ASC → xcodegen → test → archive → upload
#   → attesa dell'esito su ASC → docs → commit → push
#
# Due cose che questo script fa e la procedura a mano non faceva:
#   - il numero di build lo chiede ad App Store Connect, che e' chi rifiuta i
#     duplicati, invece di dedurlo da project.yml;
#   - non si ferma a "Uploaded TwoWatch". Quel messaggio dice che il pacchetto
#     e' partito, non che ASC l'abbia accettato: qui si aspetta che la build
#     compaia davvero e esca da PROCESSING, e se non compare il rilascio
#     fallisce.
#
# Uso:
#   scripts/ios-release.sh --title "Titolo breve" [--body "Cosa cambia."] \
#                          [--marketing 1.7.1] [--skip-tests] [--no-commit] [--dry-run]
#
# Escape hatch (usali solo sapendo cosa stai facendo):
#   ALLOW_NON_MAIN_RELEASE=1   archivia da un branch diverso da main
#   ALLOW_DIRTY_RELEASE=1      archivia con working tree sporco
#   ALLOW_UNPUSHED_RELEASE=1   archivia con commit non pushati

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IOS_DIR="$ROOT/ios"
PROJECT_YML="$IOS_DIR/project.yml"
XCODEPROJ_PBX="$IOS_DIR/TwoWatch.xcodeproj/project.pbxproj"
LOG_DIR="$HOME/somto-deploy-logs/ios"
ASC="python3 $ROOT/scripts/asc.py"

TITLE=""
BODY=""
MARKETING=""
SKIP_TESTS=0
NO_COMMIT=0
DRY_RUN=0

# `restore_project_yml` e' definita piu' sotto (serve $PROJECT_YML, che a sua
# volta serve dopo il parsing degli argomenti): qui si chiama solo se esiste
# gia'. Senza questa riga un `fail` dopo il bump lasciava il tree sporco, perche'
# `trap ... ERR` non scatta su un exit esplicito.
fail() {
  echo "[ios-release] BLOCCATO: $*" >&2
  declare -f restore_project_yml >/dev/null && restore_project_yml
  exit 1
}
info() { echo "[ios-release] $*" >&2; }
step() { echo "" >&2; echo "[ios-release] ==> $*" >&2; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --title)      TITLE="${2:-}"; shift 2 ;;
    --body)       BODY="${2:-}"; shift 2 ;;
    --marketing)  MARKETING="${2:-}"; shift 2 ;;
    --skip-tests) SKIP_TESTS=1; shift ;;
    --no-commit)  NO_COMMIT=1; shift ;;
    --dry-run)    DRY_RUN=1; shift ;;
    -h|--help)    sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)            fail "argomento sconosciuto: $1" ;;
  esac
done

# --- preflight --------------------------------------------------------------

step "preflight"

[[ -n "$TITLE" ]] || fail "serve --title: e' quello che finisce in RELEASE_PROCESS.md e in CLAUDE.md."
command -v xcodegen >/dev/null || fail "xcodegen non installato (brew install xcodegen)."
command -v jq >/dev/null || fail "jq non installato (brew install jq)."

cd "$ROOT"

BRANCH="$(git branch --show-current)"
if [[ "$BRANCH" != "main" && "${ALLOW_NON_MAIN_RELEASE:-}" != "1" ]]; then
  fail "le build TestFlight si fanno da main. Branch attuale: ${BRANCH:-(detached)}."
fi

if [[ -n "$(git status --porcelain)" && "${ALLOW_DIRTY_RELEASE:-}" != "1" ]]; then
  fail "working tree sporco. Committa o stasha prima di archiviare."
fi

git fetch --quiet origin main 2>/dev/null || info "fetch di origin/main fallito, salto il controllo di sincronia"
if [[ -n "$(git log origin/main..HEAD --oneline 2>/dev/null)" && "${ALLOW_UNPUSHED_RELEASE:-}" != "1" ]]; then
  fail "ci sono commit non pushati. Una build TestFlight deve essere ricostruibile da origin."
fi

# Gate di qualita': stessi controlli dell'hook pre-push, stessa fonte
# (scripts/ios-ci.sh). Qui pero' in modalita' lint: build Release e test li fa
# gia' questo script piu' sotto, rifarli ora raddoppierebbe i tempi.
# --skip-tests salta anche questo, coerentemente.
if [[ $SKIP_TESTS -eq 1 ]]; then
  info "gate qualita' saltato (--skip-tests)"
else
  step "gate qualita' iOS"
  "$ROOT/scripts/ios-ci.sh" --lint-only >&2 \
    || fail "gate qualita' fallito. Dettagli sopra; per forzare: --skip-tests."
fi

$ASC check >&2

if [[ $DRY_RUN -eq 1 ]]; then
  info "dry-run: mi fermo qui. Prossima build sarebbe $($ASC next-build)"
  exit 0
fi

# --- numerazione ------------------------------------------------------------

step "numero di build"

BUILD="$($ASC next-build)"
CURRENT_MARKETING="$(grep -E '^    MARKETING_VERSION:' "$PROJECT_YML" | awk '{print $2}')"
MARKETING="${MARKETING:-$CURRENT_MARKETING}"
LIVE="$($ASC live-version || true)"

info "pubblica sullo Store: ${LIVE:-(nessuna)}"
info "marketing: $CURRENT_MARKETING → $MARKETING"
info "build:     $BUILD"

# Una marketing gia' APPROVATA non si puo' ricaricare, nemmeno con un numero di
# build nuovo: l'upload muore con l'errore 90062 ("must contain a higher version
# than that of the previously approved version"). Prima lo si scopriva dopo
# l'archive, cioe' dopo un quarto d'ora di build. Vale solo per la versione
# pubblicata: iterare su TestFlight con la stessa marketing e' normale, ed e'
# quello che si e' fatto per tutta la linea 1.7.0 prima che uscisse.
if [[ -n "$LIVE" && "$MARKETING" == "$LIVE" ]]; then
  fail "la $MARKETING e' gia' pubblica sullo Store: Apple rifiuta l'upload (90062). Passa --marketing con un numero piu' alto (patch per rifiniture, minor per feature visibili — vedi docs/context/RELEASE_PROCESS.md)."
fi

if [[ "$MARKETING" != "$CURRENT_MARKETING" ]]; then
  info "ATTENZIONE: stai muovendo la versione pubblica. Regole in docs/context/RELEASE_PROCESS.md."
fi

# project.yml torna com'era se qualsiasi passo successivo fallisce: un bump
# lasciato in giro da un archive fallito e' esattamente come nascono i buchi
# tra i numeri.
#
# Col .xcodeproj INSIEME, e non e' un di piu': xcodegen gira subito dopo il bump
# e scrive il numero nuovo dentro `project.pbxproj`, che e' versionato. Se si
# ripristina solo il .yml, il tentativo dopo trova il tree sporco e si blocca
# nel preflight — cioe' un fallimento ne genera un altro.
restore_project_yml() {
  local dirty=0
  for path in "$PROJECT_YML" "$XCODEPROJ_PBX"; do
    if [[ -n "$(git status --porcelain "$path")" ]]; then
      git checkout -- "$path" 2>/dev/null || true
      dirty=1
    fi
  done
  [[ $dirty -eq 1 ]] && info "project.yml e .xcodeproj ripristinati"
  return 0
}
trap 'restore_project_yml' ERR

sed -i '' "s/^\(    MARKETING_VERSION: \).*/\1$MARKETING/" "$PROJECT_YML"
sed -i '' "s/^\(    CURRENT_PROJECT_VERSION: \).*/\1$BUILD/" "$PROJECT_YML"

step "xcodegen"
(cd "$IOS_DIR" && xcodegen generate)

mkdir -p "$LOG_DIR"

# Dove finiscono archive, export e DerivedData.
#
# PERCHE' SONO SPOSTABILI — un archive Release piu' l'export vogliono diversi
# GB, e su un disco quasi pieno falliscono con errori del compilatore che non
# c'entrano niente (stessa trappola per cui `ios-ci.sh` ha una guardia sullo
# spazio). Con `SOMTO_IOS_BUILD_DIR` si punta tutto a un volume esterno.
#
# `SOMTO_IOS_DERIVED_DATA` e' lo STESSO nome che usa gia' `ios-ci.sh`: una
# convenzione sola per entrambi gli script, cosi' si esporta una volta e vale
# per il gate e per il rilascio.
BUILD_DIR="${SOMTO_IOS_BUILD_DIR:-$IOS_DIR/build}"
mkdir -p "$BUILD_DIR"
ARCHIVE="$BUILD_DIR/Somto-$BUILD.xcarchive"
EXPORT_DIR="$BUILD_DIR/Somto-$BUILD-export"
# Un array VUOTO espanso sotto `set -u` e' un errore in bash 3.2 (quello di
# macOS): "DERIVED_ARGS[@]: unbound variable", e il rilascio moriva prima dei
# test se non si era esportato SOMTO_IOS_DERIVED_DATA. La forma
# `${a[@]+"${a[@]}"}` espande a niente quando l'array e' vuoto, invece che a una
# stringa vuota che xcodebuild leggerebbe come argomento.
DERIVED_ARGS=()
if [[ -n "${SOMTO_IOS_DERIVED_DATA:-}" ]]; then
  DERIVED_ARGS=(-derivedDataPath "$SOMTO_IOS_DERIVED_DATA")
  info "DerivedData: $SOMTO_IOS_DERIVED_DATA"
fi
[[ "$BUILD_DIR" != "$IOS_DIR/build" ]] && info "archive in $BUILD_DIR"

# --- test -------------------------------------------------------------------

if [[ $SKIP_TESTS -eq 1 ]]; then
  info "test saltati su richiesta"
else
  step "test"
  SIM_UDID="$(xcrun simctl list devices available --json \
    | jq -r '[.devices[][] | select(.name | startswith("iPhone"))] | last | .udid')"
  [[ "$SIM_UDID" != "null" && -n "$SIM_UDID" ]] || fail "nessun simulatore iPhone disponibile."

  TEST_LOG="$LOG_DIR/test-$BUILD.log"
  info "simulatore $SIM_UDID — log in $TEST_LOG"
  if ! (cd "$IOS_DIR" && xcodebuild test \
        -project TwoWatch.xcodeproj -scheme TwoWatch \
        -destination "platform=iOS Simulator,id=$SIM_UDID" \
        ${DERIVED_ARGS[@]+"${DERIVED_ARGS[@]}"} \
        > "$TEST_LOG" 2>&1); then
    tail -40 "$TEST_LOG" >&2
    fail "test falliti. Log completo: $TEST_LOG"
  fi
  grep -E "Test Suite .* passed|Executed [0-9]+ test" "$TEST_LOG" | tail -3 >&2 || true
fi

# --- archive ----------------------------------------------------------------

step "archive Release"

ARCHIVE_LOG="$LOG_DIR/archive-$BUILD.log"
info "log in $ARCHIVE_LOG"
if ! (cd "$IOS_DIR" && xcodebuild archive \
      -project TwoWatch.xcodeproj -scheme TwoWatch -configuration Release \
      -archivePath "$ARCHIVE" -destination 'generic/platform=iOS' \
      -allowProvisioningUpdates \
      ${DERIVED_ARGS[@]+"${DERIVED_ARGS[@]}"} \
      > "$ARCHIVE_LOG" 2>&1); then
  tail -40 "$ARCHIVE_LOG" >&2
  fail "archive fallito. Log completo: $ARCHIVE_LOG"
fi

# Il numero deve essere entrato davvero nel binario: e' gia' successo che
# CFBundleVersion fosse hardcoded e i bump di project.yml fossero morti.
BUILT="$(/usr/libexec/PlistBuddy -c 'Print :ApplicationProperties:CFBundleVersion' \
  "$ARCHIVE/Info.plist" 2>/dev/null || echo '?')"
[[ "$BUILT" == "$BUILD" ]] || fail "l'archive dichiara build $BUILT, atteso $BUILD."
info "archive ok, CFBundleVersion $BUILT"

# --- upload -----------------------------------------------------------------

step "upload su App Store Connect"

eval "$($ASC config-export)"

EXPORT_LOG="$LOG_DIR/export-$BUILD.log"
info "log in $EXPORT_LOG"
if ! (cd "$IOS_DIR" && xcodebuild -exportArchive \
      -archivePath "$ARCHIVE" -exportPath "$EXPORT_DIR" \
      -exportOptionsPlist ExportOptions-AppStore.plist \
      -allowProvisioningUpdates \
      -authenticationKeyPath "$ASC_KEY_PATH" \
      -authenticationKeyID "$ASC_KEY_ID" \
      -authenticationKeyIssuerID "$ASC_ISSUER_ID" \
      > "$EXPORT_LOG" 2>&1); then
  tail -40 "$EXPORT_LOG" >&2
  fail "upload fallito. Log completo: $EXPORT_LOG"
fi

# --- verifica ---------------------------------------------------------------

step "verifica su App Store Connect"
info "attendo che la build $BUILD compaia (fino a 30 min)"

STATE="$($ASC wait-build "$BUILD")"
info "build $BUILD: $STATE"

# --- docs e commit ----------------------------------------------------------

if [[ $NO_COMMIT -eq 1 ]]; then
  info "commit saltato su richiesta. Ricordati di aggiornare i docs."
  exit 0
fi

step "docs e commit"

python3 "$ROOT/scripts/ios-release-docs.py" \
  --marketing "$MARKETING" --build "$BUILD" \
  --date "$(date +%Y-%m-%d)" --state "$STATE" \
  --title "$TITLE" --body "$BODY" --live "$LIVE"

trap - ERR

# Il .pbxproj è versionato e xcodegen ci riscrive dentro il numero di build:
# senza, ogni rilascio lascia il tree sporco e il successivo si blocca da solo.
git add "$PROJECT_YML" "$IOS_DIR/TwoWatch.xcodeproj/project.pbxproj" \
  "$ROOT/docs/context/RELEASE_PROCESS.md" "$ROOT/CLAUDE.md"
git commit -m "chore(ios): build $BUILD su TestFlight

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push origin "$BRANCH"

echo "" >&2
info "fatto: $MARKETING build $BUILD, stato $STATE, docs aggiornati e pushati."
info "per inviare in verifica sullo Store:"
info "  CONFIRM_SUBMIT=$MARKETING python3 scripts/asc.py submit --marketing $MARKETING --build $BUILD --notes-file <note.json>"
