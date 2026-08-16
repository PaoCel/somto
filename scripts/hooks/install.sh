#!/usr/bin/env bash
# Attiva gli hook git versionati del repo Somto.
# Esegui una volta dopo il clone, o quando il path cambia.

set -euo pipefail

cd "$(dirname "$0")/../.."

git config core.hooksPath scripts/hooks
chmod +x scripts/hooks/pre-commit scripts/hooks/pre-push

echo "Hook attivati: $(git config core.hooksPath)"
echo "  pre-commit: uniqueKeysWithValues su chiavi derivate + regressioni i18n."
echo "  pre-push:   gate iOS (scripts/ios-ci.sh --fast) se il push tocca ios/."

if ! command -v swiftlint >/dev/null 2>&1; then
  echo
  echo "NB: swiftlint non installato — il gate iOS lo salta."
  echo "    brew install swiftlint"
fi
