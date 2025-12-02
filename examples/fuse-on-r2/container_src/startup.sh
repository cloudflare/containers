#!/bin/sh
set -e

mkdir -p "$HOME/mnt/r2/${BUCKET_NAME}"

R2_ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
echo "Mounting bucket ${BUCKET_NAME}..."
/usr/local/bin/tigrisfs --endpoint "${R2_ENDPOINT}" -f "${BUCKET_NAME}" "$HOME/mnt/r2/${BUCKET_NAME}${PREFIX:+:${PREFIX}}" &
sleep 3

echo "Starting server on :8080"
exec /server
