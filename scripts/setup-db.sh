#!/usr/bin/env bash
# setup-db.sh — siapkan user & database PostgreSQL lokal untuk ARIA (idempotent).
#
#   npm run setup:db
#   # custom: ARIA_DB_PASS=rahasia bash scripts/setup-db.sh namadb namauser
#
# Catatan: "CREATE USER ...; CREATE DATABASE ..." TIDAK BOLEH digabung dalam satu
# `psql -c` — PostgreSQL membungkusnya jadi satu transaksi, dan CREATE DATABASE
# dilarang di dalam transaksi. Makanya di sini perintahnya terpisah.
set -euo pipefail

DB_NAME="${1:-aria}"
DB_USER="${2:-aria}"
DB_PASS="${ARIA_DB_PASS:-aria}"

run_sql() { sudo -u postgres psql --no-psqlrc -tAc "$1"; }

if ! run_sql "SELECT 1" >/dev/null 2>&1; then
  echo "PostgreSQL tidak merespons. Install dulu: sudo apt-get install -y postgresql" >&2
  exit 1
fi

if run_sql "SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'" | grep -q 1; then
  echo "User '${DB_USER}' sudah ada — dilewati."
else
  run_sql "CREATE USER ${DB_USER} WITH PASSWORD '${DB_PASS}'" >/dev/null
  echo "User '${DB_USER}' dibuat."
fi

if run_sql "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1; then
  echo "Database '${DB_NAME}' sudah ada — dilewati."
else
  run_sql "CREATE DATABASE ${DB_NAME} OWNER ${DB_USER}" >/dev/null
  echo "Database '${DB_NAME}' dibuat (owner: ${DB_USER})."
fi

echo
echo "Set baris ini di .env (aktifkan/uncomment DATABASE_URL):"
echo "  DATABASE_URL=postgres://${DB_USER}:${DB_PASS}@localhost:5432/${DB_NAME}"
echo
echo "Schema tabel auto-migrate saat orchestrator boot."
