#!/usr/bin/env bash
# Run the two-node queue-keeper benchmark: two throwaway harper-pro containers on a private Docker
# network, replicating `bench_sched` over TLS (as production does), driven from the host by driver.mjs.
# See bench/queue-index/run.sh for why every staging step exists: each failure mode "succeeds"
# silently, and Harper comes up healthy having loaded nothing.
#
#   HDB_VERSION   harperfast/harper-pro image tag; default 5.2.13, the version production runs
#   ROWS          schedule rows PER NODE (default 250,000, about one production node's share)
#   WRITES        single-row writes per node per arm; both nodes write at once
#   ROUNDS        rounds of the interleaved none/keeper arms
#   RATE          paced writes/s per node (0 = as fast as possible)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
HDB_VERSION="${HDB_VERSION:-5.2.13}"
PREFIX="${BENCH_PREFIX:-prerender-keeper-cluster}"
NET="$PREFIX-net"
BASE_PORT="${BENCH_PORT:-9961}"
LOG="${BENCH_LOG:-${TMPDIR:-/tmp}/queue-keeper-cluster.log}"
PASS="bench_only_$RANDOM$RANDOM"

# The laptop is shared with other agents' benchmarks: record the host load so a contended run is visible.
echo "run.sh: host load before: $(uptime | sed 's/.*load averages*: //')" | tee "$LOG"
ps -Ao pcpu,comm | sort -k1 -nr | sed -n '1,4s/^/run.sh:   /p' | tee -a "$LOG"

STAGE="$(mktemp -d)"
cleanup() {
	for n in a b; do docker logs "$PREFIX-$n" >"$STAGE/node-$n.log" 2>&1 || true; done
	for n in a b; do
		grep -h -i -E '\[bench\]|error|warn|copy|reload' "$STAGE/node-$n.log" 2>/dev/null | sed "s/^/node-$n: /" >>"$LOG" || true
	done
	docker rm -f "$PREFIX-a" "$PREFIX-b" >/dev/null 2>&1 || true
	docker network rm "$NET" >/dev/null 2>&1 || true
	rm -rf "$STAGE"
}
trap cleanup EXIT

docker rm -f "$PREFIX-a" "$PREFIX-b" >/dev/null 2>&1 || true
docker network rm "$NET" >/dev/null 2>&1 || true
docker network create "$NET" >/dev/null

echo "run.sh: harperfast/harper-pro:$HDB_VERSION rows/node=${ROWS:-250000} writes=${WRITES:-20000} rounds=${ROUNDS:-3}" | tee -a "$LOG"

start() { # letter, http port, operations port
	local host="node-$1" dir="$STAGE/$1"
	# A copy per node: Harper may write into a component directory, and two nodes must not share one.
	mkdir -p "$dir"
	cp "$HERE"/config.yaml "$HERE"/schema.graphql "$HERE"/node.js "$HERE"/../shared.js "$dir/"
	chmod -R 777 "$dir"
	# Plain http for the driver on loopback; replication over TLS on 9933. THREADS_COUNT 2: worker 0 keeps
	# the queue, worker 1 writes. maxHeapMemory 1428: production's per-worker cap (see ../run.sh).
	local config
	config=$(printf '{"node":{"hostname":"%s"},"replication":{"hostname":"%s","port":null,"securePort":9933,"databases":["bench_sched"]},"http":{"port":9926,"securePort":null},"operationsApi":{"network":{"port":9925,"securePort":null}},"threads":{"count":2,"maxHeapMemory":1428}}' "$host" "$host")
	docker run -d --rm \
		--name "$PREFIX-$1" --hostname "$host" --network "$NET" --network-alias "$host" \
		-e HDB_ADMIN_USERNAME=bench_admin -e HDB_ADMIN_PASSWORD="$PASS" -e NODE_HOSTNAME="$host" \
		-e HARPER_SET_CONFIG="$config" \
		-e BENCH_NODES=node-a,node-b -e ROWS="${ROWS:-}" -e RATE="${RATE:-}" \
		-p "127.0.0.1:$2:9926" -p "127.0.0.1:$3:9925" \
		-v "$dir:/home/harperdb/harper/components/queue-keeper-cluster" \
		"harperfast/harper-pro:$HDB_VERSION" >/dev/null
}
start a "$BASE_PORT" "$((BASE_PORT + 4))"
start b "$((BASE_PORT + 10))" "$((BASE_PORT + 14))"

set +e
A_HTTP="$BASE_PORT" A_OPS="$((BASE_PORT + 4))" B_HTTP="$((BASE_PORT + 10))" B_OPS="$((BASE_PORT + 14))" \
	BENCH_PASS="$PASS" WRITES="${WRITES:-}" ROUNDS="${ROUNDS:-}" JOIN_KICK="${JOIN_KICK:-}" \
	JOIN_TOMBSTONE="${JOIN_TOMBSTONE:-}" BENCH_OUT="${BENCH_OUT:-}" \
	node "$HERE/driver.mjs" 2>&1 | tee -a "$LOG" | grep --line-buffered -E '\[driver\] (hello|seed|idle|join|verify|failed)|rror'
DRIVER_EXIT=${PIPESTATUS[0]}
set -e

echo "run.sh: host load after: $(uptime | sed 's/.*load averages*: //')" | tee -a "$LOG"
exit "$DRIVER_EXIT"
