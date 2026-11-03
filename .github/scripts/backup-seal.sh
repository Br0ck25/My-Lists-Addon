#!/usr/bin/env bash
# Compresses and encrypts one backup file, then proves the kept copy opens:
# decrypts it with the passphrase and runs the given checker on it against the
# counts the reader wrote beside it (<file>.counts.json). Used for the D1 and
# the KV copies (.github/workflows/d1-backup.yml). Only <file>.gz.gpg is left.
#
#   BACKUP_PASSPHRASE=... bash backup-seal.sh <file> <checker .mjs>
set -euo pipefail
file="$1"
checker="$2"
test -s "$file"
gzip -9 "$file"
gpg --batch --yes --pinentry-mode loopback --passphrase "$BACKUP_PASSPHRASE" \
  --symmetric --cipher-algo AES256 "$file.gz"
# Only the encrypted file leaves this runner.
rm -f "$file.gz"
check="$(mktemp)"
trap 'rm -f "$check"' EXIT
gpg --batch --yes --pinentry-mode loopback --passphrase "$BACKUP_PASSPHRASE" \
  --decrypt "$file.gz.gpg" | gunzip > "$check"
if ! node "$checker" "$check" "$file.counts.json"; then
  # A copy that does not restore is not kept.
  rm -f "$file.gz.gpg"
  exit 1
fi
rm -f "$file.counts.json"
