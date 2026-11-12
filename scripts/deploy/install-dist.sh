#!/usr/bin/env bash
# Installs on this server the dist that GitHub Actions compiled for the commit
# checked out here (release build-<sha7>, asset dist.tgz; see
# .github/workflows/build-dist.yml). Nothing is compiled on the VPS.
#
# Usage, from the app directory on the server, after `git pull --ff-only`:
#   scripts/deploy/install-dist.sh            # download, verify, swap dist, migrate, restart
#   scripts/deploy/install-dist.sh --check    # download and verify only; touch nothing
#
# Steps: download dist.tgz for HEAD, verify it, back up the current dist to
# /root/john-deploy-backups/<date>-<sha7>/, swap it atomically (dist is never
# left half-written), run the pending migrations (none for this app), restart the pm2
# process and wait for the port to answer.
set -euo pipefail

REPO="LumarSoft/BOT_JPMG"
PM2_NAME="john_bot"
MAIN="dist/main.js"
PORT=3002
RUN_MIGRATIONS=0
BACKUP_ROOT=/root/john-deploy-backups
export PATH=/root/.nvm/versions/node/v22.23.1/bin:$PATH

CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

APP_DIR=$(cd "$(dirname "$0")/../.." && pwd)
cd "$APP_DIR"

log() { printf '%s %s\n' "$(date +%H:%M:%S)" "$*"; }
die() { log "ERROR: $*" >&2; exit 1; }

SHA=$(git rev-parse HEAD)
SHORT=$(git rev-parse --short=7 HEAD)
TAG="build-$SHORT"
URL="https://github.com/$REPO/releases/download/$TAG/dist.tgz"

TMP=$(mktemp -d "$APP_DIR/.install-dist.XXXXXX")
trap 'rm -rf "$TMP"' EXIT

log "HEAD is $SHORT; downloading $URL"
curl -fsSL --retry 5 --retry-delay 10 -o "$TMP/dist.tgz" "$URL" \
  || die "no build published for $TAG. Did the 'Build dist' workflow finish for this commit? https://github.com/$REPO/actions"
tar xzf "$TMP/dist.tgz" -C "$TMP"

[ -f "$TMP/$MAIN" ] || die "the downloaded dist has no $MAIN"
BUILT=$(cat "$TMP/dist/BUILD_COMMIT" 2>/dev/null || echo unknown)
[ "$BUILT" = "$SHA" ] || die "the build is for commit $BUILT, not for HEAD $SHA"
NEW_COUNT=$(find "$TMP/dist" -name '*.js' | wc -l | tr -d ' ')
OLD_COUNT=$({ find dist -name '*.js' 2>/dev/null || true; } | wc -l | tr -d ' ')
log "downloaded dist OK: $NEW_COUNT JS files (current dist has $OLD_COUNT)"
if [ "$OLD_COUNT" -gt 0 ] && [ "$NEW_COUNT" -lt $(( OLD_COUNT * 9 / 10 )) ]; then
  die "the new dist has far fewer files than the current one; refusing to install"
fi

if [ "$CHECK_ONLY" = 1 ]; then
  log "--check: the build for $SHORT is valid; nothing was changed"
  exit 0
fi

OLD_COMMIT=$(cat dist/BUILD_COMMIT 2>/dev/null || echo unknown)
BACKUP="$BACKUP_ROOT/$(date +%Y%m%d-%H%M)-$PM2_NAME-$SHORT"
mkdir -p "$BACKUP"
if [ -d dist ]; then
  tar czf "$BACKUP/dist.tgz" dist
  echo "$OLD_COMMIT" > "$BACKUP/previous-commit"
fi
git diff > "$BACKUP/local.patch" || true
log "current dist backed up to $BACKUP"

if [ -f node_modules/.pnpm/lock.yaml ] && ! cmp -s pnpm-lock.yaml node_modules/.pnpm/lock.yaml; then
  log "pnpm-lock.yaml changed since the last install; running pnpm install --frozen-lockfile"
  pnpm install --frozen-lockfile
fi

# Atomic swap: the running process keeps its already-loaded code; pm2 only
# needs the new dist to exist when it restarts.
mv "$TMP/dist" dist.new
if [ -d dist ]; then mv dist dist.old; fi
mv dist.new dist
rm -rf dist.old
log "dist swapped (built from $SHORT)"

if [ "$RUN_MIGRATIONS" = 1 ]; then
  log "applying pending migrations"
  pnpm exec prisma migrate deploy
fi

pm2_field() { pm2 jlist | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const p=JSON.parse(d).find(p=>p.name===process.argv[1]);if(!p){console.log("");return}const f=process.argv[2];console.log(f==="pid"?p.pid:p.name+" "+p.pm2_env.status+" restarts "+p.pm2_env.restart_time+" mem "+Math.round(p.monit.memory/1048576)+"MB")})' "$PM2_NAME" "$1"; }
OLD_PID=$(pm2_field pid)
log "restarting $PM2_NAME (pid $OLD_PID)"
pm2 restart "$PM2_NAME" --update-env > /dev/null

for i in $(seq 1 60); do
  if [ "$(pm2_field pid)" != "$OLD_PID" ] && curl -s -o /dev/null "http://127.0.0.1:$PORT/"; then
    log "$PM2_NAME answers on port $PORT after ${i}s"
    pm2_field status
    exit 0
  fi
  sleep 1
done
log "WARNING: port $PORT did not answer within 60s; check pm2 logs $PM2_NAME"
exit 1
