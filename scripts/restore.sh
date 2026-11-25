#!/usr/bin/env bash
set -euo pipefail
: "${RESTORE_DATABASE_URL:?Use a separate EMPTY database URL}" "${AGE_IDENTITY_FILE:?Set the private identity file path}"
file="${1:?Pass the encrypted backup path}"
# No --clean: existing objects cause an error instead of deleting existing data.
age --decrypt --identity "$AGE_IDENTITY_FILE" "$file" | pg_restore --dbname="$RESTORE_DATABASE_URL" --no-owner --no-acl --exit-on-error
printf 'Restored into the specified database. Verify row counts and application access.\n'
