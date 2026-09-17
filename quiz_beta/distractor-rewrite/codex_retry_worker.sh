#!/bin/bash
# Worker Codex per i retry: coda di tag r1_NN, output out/out_z<TAG>.json.
C2="$1"; Q="$2"; cd "$C2" || exit 1
while read -r TAG; do
  [ -z "$TAG" ] && continue
  if [ -s "out/out_z${TAG}.json" ]; then echo "[$TAG] già presente, salto"; continue; fi
  PROMPT=$(sed "s/TAG/${TAG}/g" codex_retry_template.md)
  echo "[$TAG] start $(date +%H:%M:%S)"
  codex exec --skip-git-repo-check -C "$C2" -s workspace-write "$PROMPT" < /dev/null > "logs/codex_${TAG}.log" 2>&1
  if [ -s "out/out_z${TAG}.json" ]; then echo "[$TAG] ok $(date +%H:%M:%S)"; else echo "[$TAG] FAIL $(date +%H:%M:%S)"; fi
done < "$Q"
echo "WORKER_DONE $Q"
