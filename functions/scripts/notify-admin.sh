#!/usr/bin/env bash
# Send a one-shot push notification to the Somto admin via REST.
# Auth: Application Default Credentials (gcloud auth application-default login).
#
# Usage:
#   functions/scripts/notify-admin.sh "Title" "Body" [admin@email]
#
# ADMIN_NOTIFICATION_EMAIL is required unless the email is passed as arg 3.
# Defaults: title = "Somto build", body = "Aggiornamento pronto."
set -euo pipefail

PROJECT_ID="${SOMTO_PROJECT_ID:-gia-visto}"
TITLE="${1:-Somto build}"
BODY="${2:-Aggiornamento pronto.}"
EMAIL="${3:-${ADMIN_NOTIFICATION_EMAIL:-}}"
if [ -z "$EMAIL" ]; then
  echo "[notify-admin] ERROR: ADMIN_NOTIFICATION_EMAIL missing." >&2
  exit 1
fi

TOKEN="$(gcloud auth application-default print-access-token 2>/dev/null)"
if [ -z "$TOKEN" ]; then
  echo "[notify-admin] ERROR: no access token. Run 'gcloud auth application-default login'." >&2
  exit 1
fi

# 1) Resolve email -> uid via Firebase Auth admin REST
LOOKUP_PAYLOAD="{\"email\":[\"${EMAIL}\"]}"
LOOKUP=$(curl -sS \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -H "x-goog-user-project: ${PROJECT_ID}" \
  -X POST "https://identitytoolkit.googleapis.com/v1/projects/${PROJECT_ID}/accounts:lookup" \
  -d "${LOOKUP_PAYLOAD}")

USER_UID=$(printf '%s' "$LOOKUP" | python3 -c 'import sys,json; data=json.load(sys.stdin); print(data["users"][0]["localId"]) if data.get("users") else sys.exit("no user")')
if [ -z "$USER_UID" ]; then
  echo "[notify-admin] ERROR: could not resolve uid for ${EMAIL}" >&2
  echo "$LOOKUP" >&2
  exit 1
fi
echo "[notify-admin] resolved ${EMAIL} -> ${USER_UID}"

# 2) Write a notification doc that the existing onCreate trigger will fan out
#    to FCM/APNs. Use type=engagement_nudge for free-form text.
NOW_ISO=$(python3 -c 'import datetime; print(datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ"))')
EXPIRES_ISO=$(python3 -c "import datetime; print((datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=90)).strftime('%Y-%m-%dT%H:%M:%S.%fZ'))")
FROM_USER_UID="${NOTIFY_FROM_USER_UID:-system_$(date +%s)}"

# Reset cooldown so engagement_nudge fires every time we run this (otherwise the
# 6h window inside notifyOnNotificationCreated suppresses subsequent pushes).
curl -sS \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -H "x-goog-user-project: ${PROJECT_ID}" \
  -X DELETE \
  "https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/users/${USER_UID}/_system/pushCooldown_engagement_nudge" \
  > /dev/null || true

PAYLOAD=$(python3 - "$USER_UID" "$FROM_USER_UID" "$TITLE" "$BODY" "$NOW_ISO" "$EXPIRES_ISO" <<'PY'
import json, sys
to_uid, from_uid, title, body, now_iso, expires_iso = sys.argv[1:7]
doc = {
    "fields": {
        "toUid": {"stringValue": to_uid},
        "fromUid": {"stringValue": from_uid},
        "type": {"stringValue": "engagement_nudge"},
        "read": {"booleanValue": False},
        "createdAt": {"timestampValue": now_iso},
        "expiresAt": {"timestampValue": expires_iso},
        "data": {
            "mapValue": {
                "fields": {
                    "title": {"stringValue": title},
                    "message": {"stringValue": body},
                    "ctaUrl": {"stringValue": "/account.html?tab=activity"},
                }
            }
        }
    }
}
print(json.dumps(doc))
PY
)

CREATE=$(curl -sS \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -H "x-goog-user-project: ${PROJECT_ID}" \
  -X POST \
  "https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/users/${USER_UID}/notifications" \
  -d "${PAYLOAD}")
DOC_NAME=$(printf '%s' "$CREATE" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("name",""))')
if [ -z "$DOC_NAME" ]; then
  echo "[notify-admin] ERROR: failed to create notification doc" >&2
  echo "$CREATE" >&2
  exit 1
fi
echo "[notify-admin] created notification at ${DOC_NAME##*/}"
echo "[notify-admin] push will be dispatched by notifyOnNotificationCreated trigger"
