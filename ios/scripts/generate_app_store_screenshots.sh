#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ARTIFACT_DIR="${ROOT_DIR}/.codex-artifacts/app-store-screenshots"
DERIVED_DATA_DIR="${ARTIFACT_DIR}/DerivedData"
APP_PATH="${DERIVED_DATA_DIR}/Build/Products/Debug-iphonesimulator/Somto.app"
BUNDLE_ID="com.paolocelestini.twowatch.ios"
SCENES=(home watchlist search notifications profile title)

runtime_id() {
  xcrun simctl list runtimes | sed -n 's/.* - \(com\.apple\.CoreSimulator\.SimRuntime\.iOS[^[:space:]]*\)$/\1/p' | tail -1
}

find_or_create_device() {
  local display_name="$1"
  local device_type="$2"
  local runtime="$3"
  local udid

  udid="$(xcrun simctl list devices available | awk -F '[()]' -v name="${display_name}" '$1 ~ "^[[:space:]]*"name" " { print $2; exit }')"
  if [[ -z "${udid}" ]]; then
    udid="$(xcrun simctl create "${display_name}" "${device_type}" "${runtime}")"
  fi
  printf '%s\n' "${udid}"
}

prepare_device() {
  local udid="$1"
  xcrun simctl shutdown "${udid}" >/dev/null 2>&1 || true
  xcrun simctl erase "${udid}" >/dev/null 2>&1 || true
  xcrun simctl boot "${udid}" >/dev/null
  xcrun simctl bootstatus "${udid}" -b
  open -a Simulator --args -CurrentDeviceUDID "${udid}" >/dev/null 2>&1 || true
  xcrun simctl ui "${udid}" appearance dark >/dev/null 2>&1 || true
  xcrun simctl status_bar "${udid}" override \
    --time "9:41" \
    --dataNetwork wifi \
    --wifiMode active \
    --wifiBars 3 \
    --cellularMode active \
    --cellularBars 4 \
    --batteryState charged \
    --batteryLevel 100 \
    >/dev/null
}

capture_scene() {
  local udid="$1"
  local scene="$2"
  local output_path="$3"

  xcrun simctl terminate "${udid}" "${BUNDLE_ID}" >/dev/null 2>&1 || true
  SIMCTL_CHILD_APP_STORE_SCREENSHOT_SCENE="${scene}" \
    xcrun simctl launch "${udid}" "${BUNDLE_ID}" --terminate-running-process >/dev/null
  sleep 4
  xcrun simctl io "${udid}" screenshot "${output_path}" >/dev/null
  xcrun simctl terminate "${udid}" "${BUNDLE_ID}" >/dev/null 2>&1 || true
}

main() {
  mkdir -p "${ARTIFACT_DIR}"

  local runtime
  runtime="$(runtime_id)"
  if [[ -z "${runtime}" ]]; then
    echo "No available iOS simulator runtime found." >&2
    exit 1
  fi

  echo "Using runtime: ${runtime}"
  echo "Building debug app for simulator..."
  xcodebuild \
    -project "${ROOT_DIR}/ios/TwoWatch.xcodeproj" \
    -scheme TwoWatch \
    -destination "generic/platform=iOS Simulator" \
    -derivedDataPath "${DERIVED_DATA_DIR}" \
    CODE_SIGNING_ALLOWED=NO \
    build >/dev/null

  if [[ ! -d "${APP_PATH}" ]]; then
    echo "Built app not found at ${APP_PATH}" >&2
    exit 1
  fi

  declare -a device_specs=(
    "iphone-69|Somto App Store 6.9|com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro-Max"
    "iphone-65|Somto App Store 6.5|com.apple.CoreSimulator.SimDeviceType.iPhone-11-Pro-Max"
  )

  for spec in "${device_specs[@]}"; do
    IFS='|' read -r folder_name display_name device_type <<< "${spec}"
    local_output_dir="${ARTIFACT_DIR}/${folder_name}"
    mkdir -p "${local_output_dir}"

    udid="$(find_or_create_device "${display_name}" "${device_type}" "${runtime}")"
    echo "Preparing ${display_name} (${udid})..."
    prepare_device "${udid}"
    xcrun simctl install "${udid}" "${APP_PATH}" >/dev/null

    index=1
    for scene in "${SCENES[@]}"; do
      file_name="$(printf '%02d-%s.png' "${index}" "${scene}")"
      echo "Capturing ${folder_name}/${file_name}"
      capture_scene "${udid}" "${scene}" "${local_output_dir}/${file_name}"
      index=$((index + 1))
    done

    xcrun simctl status_bar "${udid}" clear >/dev/null 2>&1 || true
    xcrun simctl shutdown "${udid}" >/dev/null 2>&1 || true
  done

  echo "Screenshots generated in ${ARTIFACT_DIR}"
}

main "$@"
