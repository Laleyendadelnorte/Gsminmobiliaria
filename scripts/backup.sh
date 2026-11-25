#!/usr/bin/env bash
set -euo pipefail
: "${DATABASE_URL:?Set DATABASE_URL}" "${AGE_RECIPIENT:?Set the age PUBLIC recipient}"
out="${1:-backups/gcm-$(date -u +%Y%m%dT%H%M%SZ).dump.age}"
mkdir -p "$(dirname "$out")"
umask 077
pg_dump "$DATABASE_URL" --format=custom --no-owner --no-acl | age --recipient "$AGE_RECIPIENT" --output "$out"
printf 'Encrypted database backup saved: %s\n' "$out"

if [[ -d "${MEDIA_ROOT:-.storage}" ]]; then
  media_out="${out%.dump.age}.media.tar.age"
  tar -C "${MEDIA_ROOT:-.storage}" -cf - . | age --recipient "$AGE_RECIPIENT" --output "$media_out"
  printf 'Encrypted media archive saved: %s\n' "$media_out"
fi
