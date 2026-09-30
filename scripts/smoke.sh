#!/usr/bin/env bash
# Smoke test against a running VCKB server. Used by the Docker CI job; also runs locally.
#
#   VCKB_TOKEN=...  BASE_URL=http://127.0.0.1:8787  BOARDS_DIR=./boards  [EXPECT_OWNER=1000:1000]  scripts/smoke.sh
#
# BOARDS_DIR is the host path of the boards (the volume); EXPECT_OWNER, if set, is the uid:gid
# the created task file must belong to. Exits non-zero on the first failed check.
set -euo pipefail

: "${VCKB_TOKEN:?VCKB_TOKEN is required}"
: "${BOARDS_DIR:?BOARDS_DIR is required}"
BASE_URL="${BASE_URL:-http://127.0.0.1:8787}"
SLUG="smoke-$(date +%s)-$$"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok: $*"; }

status() { # status METHOD PATH [curl args...] -> prints the HTTP status
  local method=$1 path=$2
  shift 2
  curl -sS -o /dev/null -w '%{http_code}' -X "$method" "$@" "$BASE_URL$path"
}

# Wait for the server (up to 30 s).
for _ in $(seq 1 60); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/api/projects" || true)
  [ "$code" != "000" ] && break
  sleep 0.5
done
[ "${code:-000}" != "000" ] || fail "server did not answer at $BASE_URL"

code=$(status GET /api/projects)
[ "$code" = 401 ] || fail "without token: expected 401, got $code"
ok "without token -> 401"

code=$(status GET /api/projects -H "Authorization: Bearer wrong-token-0000000000")
[ "$code" = 401 ] || fail "wrong token: expected 401, got $code"
ok "wrong token -> 401"

auth=(-H "Authorization: Bearer $VCKB_TOKEN")
code=$(status GET /api/projects "${auth[@]}")
[ "$code" = 200 ] || fail "with token: expected 200, got $code"
ok "with token -> 200 on /api/projects"

json=(-H 'Content-Type: application/json')
code=$(status POST /api/projects "${auth[@]}" "${json[@]}" -d "{\"name\":\"Smoke\",\"slug\":\"$SLUG\"}")
[ "$code" = 201 ] || fail "create project: expected 201, got $code"
ok "project $SLUG created"

body=$(curl -sS --fail-with-body -X POST "${auth[@]}" "${json[@]}" -d '{"title":"Smoke task","status":"todo"}' "$BASE_URL/api/projects/$SLUG/tasks") \
  || fail "create task: $body"
echo "$body" | grep -q '"id":"T-001"' || fail "create task: unexpected body $body"
ok "task T-001 created through the API"

file="$BOARDS_DIR/$SLUG/tasks/T-001-smoke-task.md"
[ -f "$file" ] || fail "task file not found in the volume: $file"
grep -q '^status: todo$' "$file" || fail "task file content unexpected: $(cat "$file")"
ok "task file present in the volume: $file"

if [ -n "${EXPECT_OWNER:-}" ]; then
  owner=$(stat -c '%u:%g' "$file")
  [ "$owner" = "$EXPECT_OWNER" ] || fail "task file owner: expected $EXPECT_OWNER, got $owner"
  ok "task file owned by $owner"
fi

code=$(status GET /api/projects "${auth[@]}" -H 'Host: evil.example')
[ "$code" = 421 ] || fail "foreign Host header: expected 421, got $code"
ok "foreign Host header -> 421 (DNS rebinding guard)"

# Web UI session: token -> HttpOnly cookie; cookie-authenticated writes need the CSRF proof.
jar=$(mktemp)
trap 'rm -f "$jar"' EXIT
ui=(-H "Origin: $BASE_URL" -H 'X-VCKB-CSRF: 1')
code=$(status POST /api/session "${ui[@]}" "${json[@]}" -c "$jar" -d "{\"token\":\"$VCKB_TOKEN\"}")
[ "$code" = 200 ] || fail "login: expected 200, got $code"
grep -q 'vckb_session' "$jar" || fail "login: no vckb_session cookie"
grep -q '#HttpOnly_' "$jar" || fail "login: cookie is not HttpOnly"
ok "login -> HttpOnly session cookie"

code=$(status GET /api/projects -b "$jar")
[ "$code" = 200 ] || fail "cookie read: expected 200, got $code"
code=$(status POST "/api/projects/$SLUG/tasks" -b "$jar" "${json[@]}" -d '{"title":"no csrf"}')
[ "$code" = 403 ] || fail "cookie write without CSRF proof: expected 403, got $code"
code=$(status POST "/api/projects/$SLUG/tasks" -b "$jar" "${json[@]}" -H 'X-VCKB-CSRF: 1' -H 'Origin: http://evil.example' -d '{"title":"x"}')
[ "$code" = 403 ] || fail "cookie write from a foreign Origin: expected 403, got $code"
code=$(status POST "/api/projects/$SLUG/tasks" -b "$jar" "${ui[@]}" "${json[@]}" -d '{"title":"from the ui"}')
[ "$code" = 201 ] || fail "cookie write with CSRF proof: expected 201, got $code"
ok "cookie: reads 200, writes 403 without CSRF proof / foreign Origin, 201 with it"

code=$(status POST /api/session/logout -b "$jar" -c "$jar" "${ui[@]}")
[ "$code" = 204 ] || fail "logout: expected 204, got $code"
code=$(status GET /api/projects -b "$jar")
[ "$code" = 401 ] || fail "after logout: expected 401, got $code"
ok "logout clears the session"

leftovers=$(find "$BOARDS_DIR/$SLUG" -name '*.tmp-*' -o -name '.vckb.lock*' | head -n 5)
[ -z "$leftovers" ] || fail "temp/lock files left behind: $leftovers"
ok "no temp or lock files left behind"

echo "SMOKE TEST PASSED"
