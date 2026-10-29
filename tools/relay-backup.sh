#!/bin/bash
set -euo pipefail
umask 077
TS=$(date -u +%Y%m%dT%H%M%SZ)
OUT="/var/lib/relay/backups/relay-${TS}.tgz"
BUCKET="gs://relay-prod-backups-a22a835c"
tar -C / -czf "$OUT" var/lib/relay/.data var/lib/relay/cloud.sqlite var/lib/relay/tenants etc/relay/relay.env
SHA=$(sha256sum "$OUT" | awk '{print $1}')
echo "$SHA  $(basename "$OUT")" > "${OUT}.sha256"

# Offsite copy. Fail loudly: a backup that exists only on the VM is not a backup.
/snap/bin/gsutil cp "$OUT" "${BUCKET}/$(basename "$OUT")"
/snap/bin/gsutil cp "${OUT}.sha256" "${BUCKET}/$(basename "$OUT").sha256"

find /var/lib/relay/backups -maxdepth 1 -name 'relay-*.tgz*' -mtime +7 -delete
