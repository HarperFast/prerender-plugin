#!/usr/bin/env bash
# Run the queue-index benchmark against an ISOLATED Harper.
#
# Isolation is not a nicety. The harness writes hundreds of thousands of rows and measures a storage
# engine, so it must not share a root with a running instance (two processes on one LMDB root), must
# not share a root with real data, and must not collide on ports with a Harper you already have up.
#
#   BENCH_MODE=docker  (default)  a throwaway container, the way kohls-pr's CI stands Harper up.
#   BENCH_MODE=local              an installed local root under $BENCH_ROOT.
#
# VERIFICATION STATUS, stated because an unrun benchmark runner is worse than none: neither mode has
# been executed end to end. Docker was unavailable on the machine this was written on (daemon not
# running), and the local mode reached Harper's startup and then failed in `checkForExistingInstall`
# ("database 'system' does not exist") against a freshly installed root — a Harper bootstrap problem,
# not a problem with the measurements. Expect to debug the harness once before trusting a number
# from it, and treat the first run as a calibration run.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
MODE="${BENCH_MODE:-docker}"
PORT="${BENCH_PORT:-9977}"
ROWS="${ROWS:-200000}"
REPEATS="${REPEATS:-5}"
CHURN="${CHURN:-40000}"
HDB_VERSION="${HDB_VERSION:-latest}"

if [[ "$MODE" == "docker" ]]; then
	CONTAINER="${BENCH_CONTAINER:-prerender-queue-bench}"
	docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
	echo "run.sh: starting harperfast/harper:$HDB_VERSION as $CONTAINER on $PORT"
	# STAGED INTO A TEMP DIR AND MOUNTED READ-WRITE, not mounted read-only from the repo. Harper's
	# component loader creates `node_modules` inside the component directory to symlink the `harper`
	# module, so a read-only mount fails the whole component with EROFS and the server comes up
	# perfectly happy with nothing loaded. Staging keeps that write out of the working tree.
	STAGE="$(mktemp -d)"
	# WORLD-WRITABLE ON PURPOSE. `mktemp -d` is 0700 owned by the host user; the container runs as
	# `harperdb`, and Harper's component loader has to CREATE `node_modules` inside the mount to symlink
	# itself. Without this the component fails with EROFS/EACCES and the server comes up perfectly
	# healthy having loaded nothing — the silent-success failure this harness has already hit once.
	# (Docker Desktop on macOS remaps ownership and hides it; on Linux and in CI it does not.) Safe
	# here: a throwaway directory holding three harness files, removed on exit.
	chmod 777 "$STAGE"
	cp "$HERE"/config.yaml "$HERE"/schema.graphql "$HERE"/bench.js "$STAGE/"
	trap 'rm -rf "$STAGE"' EXIT

	docker run --rm \
		--name "$CONTAINER" \
		-e HDB_ADMIN_USERNAME=bench_admin \
		-e HDB_ADMIN_PASSWORD="bench_only_$RANDOM" \
		-e OPERATIONSAPI_NETWORK_PORT="$((PORT + 4))" \
		-e THREADS_COUNT=1 \
		-e ROWS="$ROWS" -e REPEATS="$REPEATS" -e CHURN="$CHURN" \
		-p "$PORT:9926" \
		-v "$STAGE:${BENCH_COMPONENT_DIR:-/home/harperdb/harper/components/queue-index}" \
		"harperfast/harper:$HDB_VERSION"
	exit $?
fi

ROOT="${BENCH_ROOT:-${TMPDIR:-/tmp}/prerender-bench-root}"
case "$ROOT" in
	"$HOME"/hdb|"$HOME"/hdb/*) echo "run.sh: refusing to use your real Harper root ($ROOT)" >&2; exit 1 ;;
esac

if [[ -n "${KEEP_ROOT:-}" && -d "$ROOT/database/system" ]]; then
	echo "run.sh: reusing $ROOT (KEEP_ROOT set)"
else
	rm -rf "$ROOT"
	echo "run.sh: installing a fresh Harper root at $ROOT"
	# Non-interactive: the installer takes the uppercased prompt names as env vars, so no TTY needed.
	ROOTPATH="$ROOT" \
	HDB_ADMIN_USERNAME=bench_admin \
	HDB_ADMIN_PASSWORD="bench_only_$RANDOM" \
	HTTP_PORT="$PORT" \
	OPERATIONSAPI_NETWORK_PORT="$((PORT + 4))" \
	REPLICATION_SECUREPORT="$((PORT + 1))" \
		harper install
fi

CFG="$ROOT/harperdb-config.yaml"
# One worker: these are per-operation costs, and several workers racing the same tables would measure
# contention instead.
[[ -f "$CFG" ]] && { sed -i.bak -E '/^threads:/,/^[a-zA-Z]/ s/^  count: .*/  count: 1/' "$CFG"; rm -f "$CFG.bak"; }

echo "run.sh: root=$ROOT port=$PORT rows=$ROWS"
cd "$HERE"
ROOTPATH="$ROOT" ROWS="$ROWS" REPEATS="$REPEATS" CHURN="$CHURN" harper run .
