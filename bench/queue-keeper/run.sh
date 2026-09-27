#!/usr/bin/env bash
# Run the queue-keeper benchmark against an ISOLATED, throwaway Harper container (see
# bench/queue-index/run.sh for why every one of these steps exists — each failure mode here "succeeds"
# silently: Harper comes up healthy having loaded nothing).
#
#   HDB_VERSION   image tag; default 5.2.13, the version production runs
#   ROWS          schedule rows (default 250,000, about one node's share of a 1M-row, 4-node corpus)
#   WRITES/ROUNDS writes per arm, rounds of the none/count/keeper arms
#   RATE          paced writes/s (0 = as fast as possible)
#   BATCH         rows per transaction in the batch arm (0 skips it)
#   MEM_SIZES     comma-separated row counts for the memory test
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PORT="${BENCH_PORT:-9987}"
HDB_VERSION="${HDB_VERSION:-5.2.13}"
CONTAINER="${BENCH_CONTAINER:-prerender-keeper-bench}"
LOG="${BENCH_LOG:-${TMPDIR:-/tmp}/queue-keeper-bench.log}"

# The laptop is shared with other agents' benchmarks: record the host load so a contended run is visible.
echo "run.sh: host load before: $(uptime | sed 's/.*load averages*: //')" | tee "$LOG"
ps -Ao pcpu,comm | sort -k1 -nr | head -4 | sed 's/^/run.sh:   /' | tee -a "$LOG"

docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
STAGE="$(mktemp -d)"
chmod 777 "$STAGE"
cp "$HERE"/config.yaml "$HERE"/schema.graphql "$HERE"/bench.js "$STAGE/"
trap 'rm -rf "$STAGE"' EXIT

echo "run.sh: harperfast/harper:$HDB_VERSION rows=${ROWS:-250000} writes=${WRITES:-20000} rounds=${ROUNDS:-3}" | tee -a "$LOG"
# THREADS_COUNT=2: worker 0 subscribes and keeps the queue, worker 1 writes — production's split.
# THREADS_MAXHEAPMEMORY=1428: the per-worker heap cap production gets from Harper's default formula
# (min(RAM, 20000 MB) / (10 + threads/4) = 20000 / 14 on a 31 GB, 16-thread node).
docker run --rm \
	--name "$CONTAINER" \
	-e HDB_ADMIN_USERNAME=bench_admin \
	-e HDB_ADMIN_PASSWORD="bench_only_$RANDOM" \
	-e OPERATIONSAPI_NETWORK_PORT="$((PORT + 4))" \
	-e THREADS_COUNT=2 \
	-e THREADS_MAXHEAPMEMORY=1428 \
	-e ROWS="${ROWS:-}" -e WRITES="${WRITES:-}" -e ROUNDS="${ROUNDS:-}" -e RATE="${RATE:-}" \
	-e BATCH="${BATCH:-}" -e MEM_SIZES="${MEM_SIZES:-}" \
	-p "$PORT:9926" \
	-v "$STAGE:/home/harperdb/harper/components/queue-keeper" \
	"harperfast/harper:$HDB_VERSION" 2>&1 | tee -a "$LOG" | grep --line-buffered -E '\[bench\]|rror|WARN' || true

echo "run.sh: host load after: $(uptime | sed 's/.*load averages*: //')" | tee -a "$LOG"
