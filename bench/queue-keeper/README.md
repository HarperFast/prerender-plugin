# `bench/queue-keeper` — what an in-memory queue keeper would cost

Prices "design C" for exposing queue state: one thread per node keeps the render queue in memory, fed
by a subscription on `RenderSchedule`, instead of walking the `nextRenderTime` index. It measures the
two things that decide whether that is viable: the **subscription's cost per write** and the
**keeper's memory**. It also checks that the in-memory copy stays exactly equal to the table.

The [two-node harness](#two-nodes-cluster) adds replication: residency-pinned rows, writes from both
nodes, and a node joining the cluster.

> **Absolute numbers are floors.** This is a fresh corpus. [`bench/queue-index`](../queue-index/README.md)
> measured production reads 20–30× slower per row on a churned store. Compare arms with each other;
> don't size production from the absolute figures.

## Running it

```bash
ROWS=250000 WRITES=50000 ROUNDS=5 ./run.sh
```

Needs Docker. It starts a throwaway `harperfast/harper` container (default `5.2.13`) with two worker
threads: worker 0 subscribes and keeps the queue, worker 1 writes. Output is `[bench]` lines, ending in
`[bench] RESULT {...}`. **If no `[bench]` lines appear, assume the component did not load.** Harper
comes up healthy either way (see the queue-index README for the causes). The host's load average is
logged before and after the run; another heavy process on the machine invalidates the timings.

Arms (single-row commits, the shape of production's reschedule writes), interleaved round-robin:

| Arm      | Worker 0                                           |
| -------- | -------------------------------------------------- |
| `none`   | no subscription                                    |
| `count`  | subscription, listener only counts events          |
| `keeper` | subscription, listener updates the in-memory queue |

## Results (2026-09-27, Harper 5.2.13, 250k rows, 50k writes/arm, 5 rounds)

Medians of the clean rounds. Three rounds were excluded because the subscription replayed writes made
before it existed (see below).

|                         | `none`      | `count`     | `keeper`                                 |
| ----------------------- | ----------- | ----------- | ---------------------------------------- |
| put p50 / p99           | 92 / 183 µs | 97 / 188 µs | 98 / 212 µs                              |
| process CPU per write   | 106 µs      | 142 µs      | 152 µs                                   |
| worker 0 busy per write | —           | 26 µs       | 31 µs (3 µs of it the keeper's own work) |
| events per write        | —           | 1           | 1                                        |
| delivery lag p99 / max  | —           | 0.8 / 11 ms | 0.8 / 51 ms                              |

- **Exact:** after a final keeper arm, the in-memory copy matched the table on 250,000 of 250,000
  rows (0 missing, 0 mismatched). A subscription on worker 0 saw every commit made on worker 1.
- **Memory:** about 136 B/row for the key strings (109-character URLs) plus 64–80 B/row for the
  keeper's structures. That's 48 MB at 250k rows, 93 MB at 500k, and 191 MB at 1M.
- **Claim side:** the best 5,000 due rows came back in 0.16–0.25 ms (max under 1 ms). Full counts
  took under 2 ms. Moving a row between buckets costs 0.5–1 µs.
- **Rebuild** from a primary-key scan: 0.9 s for 250k rows here; expect 20–30× that on a churned
  production store.

## Harper behaviour this depends on (read from the 5.2.13 source)

- **The subscription's work runs on the subscribing thread.** Each commit schedules one catch-up pass
  (`setImmediate`, bursts merged), which walks the database's audit log. `RenderSchedule` is alone in
  its database, so only its own commits pay.
- **Events carry the current state.** Before delivering, Harper reads the row: it drops an event
  whose version is stale and sends the current value, or a delete if the row is gone. A keeper can
  apply the value directly.
- **Replay after a gap.** Suppose a thread's subscriptions all end and a new one starts later. The
  new one receives every row written in between, with its current value: about 45k extra events
  after each `none` arm here. The mechanism, from `core/resources/transactionBroadcast.ts`: each
  thread walks a database's audit log with one reusable iterator, the walk is skipped while the
  thread has no subscriber, and the next commit resumes it from where it stopped. So the replay
  arrives with the **first commit after** subscribing, not at subscribe time, and it grows with the
  length of the gap. That's harmless to a keeper (applying a row twice changes nothing), and it
  means subscribe-then-scan cannot miss a write. It does inflate cost figures, so this harness counts
  these separately (`replayedFromBeforeArm`); the two-node harness commits once itself before each
  window so the replay lands outside it.
- **A replication base copy** that carries any row of a table makes Harper re-deliver the whole table
  as puts (`reload`): see [Joining the cluster](#joining-the-cluster).

## Two nodes: `cluster/`

Answers what one container cannot: does each node's keeper stay exact when half its writes arrive by
replication, and what does a node joining the cluster cost a live keeper?

```bash
ROWS=250000 WRITES=50000 ROUNDS=3 JOIN_TOMBSTONE=1 ./cluster/run.sh
```

Needs Docker and the `harperfast/harper-pro` image (default `5.2.13`); replication is not in the
open-source image. `run.sh` starts two containers on a private network, replicating `bench_sched` over
TLS, and `driver.mjs` sequences them from the host through a mailbox row in a non-replicated table.
Each node has 2 worker threads: worker 0 keeps the queue, worker 1 writes. `run.sh` exits non-zero if
the driver fails.

The table is pinned the way production pins `RenderSchedule`: `setResidencyById(key => [owner])`, the
owner picked by rendezvous hashing with production's hash. So each node stores only its own rows, and
both nodes write rows of both owners. `ROWS` is per node.

| Phase  | What happens                                                                                    |
| ------ | ----------------------------------------------------------------------------------------------- |
| seed   | each node, not yet clustered, writes the rows it owns; keepers rebuild; a 10 s idle baseline    |
| join   | keepers live on both nodes, then `add_node`, which requests a full copy each way                |
| arms   | `none` / `keeper`, interleaved and rotated per round; both writers run at once                  |
| verify | rebuild, one more keeper arm, then each keeper against its own table and every row on its owner |

- `JOIN_TOMBSTONE=1` deletes one row on each node before the join, so each base copy carries a row
  (see [Joining the cluster](#joining-the-cluster)). `JOIN_KICK=0` skips the join keepers' kick.
- Each write's due time is shifted by at most 1 ms so its value says which node wrote it: that is how
  a listener tells a replicated write from a local one.
- A keeper arm first rewrites one row it owns (the kick, one commit) and waits for quiet, so the gap
  replay described above lands outside the window. Every window closes 1.5 s after the writers finish,
  in both arms.
- After each keeper arm the driver checks **coverage**: every distinct row written to a node, by
  either node, must have reached that node's keeper as a `put`.

### What each node's subscription receives

Verified against the 5.2.13 source, and observed in every run:

| Write                     | On the writer         | On the other node     |
| ------------------------- | --------------------- | --------------------- |
| a row the writer owns     | `put`, with the value | nothing               |
| a row the other node owns | `delete`, no value    | `put`, with the value |

- The writer stores nothing for a row it does not own (`recordUpdater` skips the store when the record
  is `undefined`), so the listener's re-read finds no entry and sends `delete`. Applied to a keeper,
  that is a no-op.
- The sender skips a row the peer does not own: with `setResidencyById`, "we don't even need any data
  sent to other servers" (`replicationConnection.ts`).
- So a keeper can apply every event as it comes, with no ownership check. Its cost is one event per
  write to a row it owns, from either node, plus one no-op `delete` per write it makes to a row it
  does not own.
- **Deleted rows are the exception.** A deleted row's entry did cross to the peer in a base copy
  (below). Live deletes were not measured.

### Results (2026-09-27, harper-pro 5.2.13, 250k rows per node, 50k writes per node per arm, 3 rounds)

Both nodes wrote at once, 7,050–8,080 writes/s each (14.4k–15.8k cluster writes/s). Per node, medians
of the 3 rounds; the range across rounds is in brackets. Put rows give node-a's and node-b's medians.
Host load was 4.7 before and 4.1 after the run.

|                                          | `none`               | `keeper`             |
| ---------------------------------------- | -------------------- | -------------------- |
| process CPU per cluster write            | 134 µs (123–141)     | 137 µs (133–138)     |
| worker 0 busy per cluster write          | 44–51 µs             | 55–59 µs             |
| put p50 / p99, a row this node owns      | 131–135 / 267 µs     | 126–132 / 240–247 µs |
| put p50 / p99, a row the other node owns | 104–110 / 235–237 µs | 103–111 / 218–220 µs |

- **The owner receives every replicated write** (verified by coverage). In all 8 keeper windows (3
  arms plus the verify arm, on both nodes):
  - every distinct row written to the node was delivered to its keeper (0 missing);
  - the `delete`s equalled the node's own writes to foreign rows exactly;
  - no `put` arrived for a row the node does not own.
- **`put`s fell 1–4 short of writes per 50k.** Coverage shows these are superseded versions: about
  4,600–4,700 rows per window were written more than once, and Harper sends only a row's current
  version.
- **Correct at the end:** after the verify arm, the two tables held 500,000 of 500,000 rows, every one
  on its owner, and each keeper matched its own table row for row (0 missing, 0 mismatched, 0 extra).
- **Delivery lag,** from the writer's commit to the owner's listener:
  - a local write: p50 −0.3 ms, p99 2–27 ms;
  - a replicated write: p50 0.3–0.4 ms, p99 42–105 ms, max 108 ms.
  - The negative local p50 means commit versions run about 0.3 ms ahead of `Date.now()`, so
    replicated lags read low by about that much.
  - This is at about 15k cluster writes/s; [#215](https://github.com/HarperFast/prerender-plugin/issues/215)
    estimates production at under 10 schedule writes/s per node.
- **Cost:**
  - **Process CPU**, paired by round (`keeper` minus `none`): −4.3, +2.3 and +11.5 µs per cluster
    write on node-a; +1.1, +3.6 and +10.4 on node-b. That spread is as large as the effect.
  - **Worker 0** rose consistently, by 7–13 µs per cluster write. That is 10–17 µs per delivered event
    (about 0.75 events per cluster write), against 31 µs per event on a single node. Why it is lower
    with replication is not known.
  - **The keeper's own apply work** was 3.0–3.2 µs per event, or 4.5–4.8 µs per `put`.
  - **Put latency** showed no cost: keeper arms were, if anything, slightly faster.
- **Idle baseline:** with no writes and no subscription, a node used 71–78 ms of process CPU per
  second, and worker 0 was busy 229–240 ms per second. That busy time is about 21–22 µs of the `none`
  arm's worker-0 figure.
- **The keeper shares its thread with replication.** On both nodes `cluster_status` put the
  `bench_sched` replication socket on thread 1, which is worker 0's `threadId`. `cluster_status`
  lists one socket per peer per database.
- **Gap replay:** a keeper arm that followed a `none` arm first received the whole gap. Each distinct
  row written in the gap arrived as one `put`, and each write to a foreign row as one `delete`. That
  was about 70k events after one `none` arm and 132k after two. All of it landed in the settle,
  outside the window.

### Joining the cluster

`add_node` requested a full copy of `bench_sched` each way, and replication was connected both ways
2.2–2.4 s later. What the live keepers received turned on one thing: whether a base copy carried
any row of the table at all, even one the receiver then skipped.

| The base copy carried a row   | Each keeper received              | Runs                |
| ----------------------------- | --------------------------------- | ------------------- |
| yes: one deleted row per node | its node's whole table, as `put`s | 8 (6 small, 2 full) |
| no                            | nothing                           | 4 (3 small, 1 full) |

- **The deleted row** came from `JOIN_TOMBSTONE`, or, in 5 of the 8 runs, from an earlier kick that
  put and deleted a sentinel row after subscribing.
- **A commit on the keeper's thread made no difference.** Each row of the table includes runs with and
  without a post-subscribe commit.
- **What crossed:**
  - The residency skip drops every live row the receiver does not own, but a deleted row's entry still
    crossed. The receiver logged `Skipping a source-applied put with no record content … valueless
source put` once per direction in every tombstone run, and never otherwise (observed).
  - **Hypothesis** for why it crosses: a deleted entry carries no residency id.
- **What it triggered:** having received a copied row for the table, even one it skipped storing, the
  receiver writes a `reload` marker for it. Harper then re-sends every live subscriber the table's current rows
  ([harper-pro#495](https://github.com/HarperFast/harper-pro/issues/495), in 5.2.13; source path
  `copiedTablesThisPass` → `emitCopyReloadMarkers` → the re-snapshot in `Table.subscribe`).
- **Row counts and keepers were unaffected either way.** Counts were identical before and after every
  join, and both keepers still matched their tables exactly.
- **The cost of the re-send, at 250k rows per node:**
  - Each keeper received its table in about 1.2 s: node-b from 1.6 to 2.8 s after `add_node`, node-a
    from 3.5 to 4.6 s.
  - Applying it took 1.5 µs per event, about 0.4 s of keeper work.
  - Beyond that, the re-send is not separable from the copy itself. Comparing full-size join windows with it (two runs)
    and without it (one), worker-0 time differed by −0.2 to +0.8 s per node, and process CPU by +0.1 to
    +1.0 s.
- **Production** (inference): `RenderSchedule` rows do get deleted, so a node's table probably holds
  deleted entries. If it does, every base copy of `render_schedule` re-sends each receiving node's
  whole table to its live subscribers. That is harmless to a keeper, which applies it idempotently,
  but it is a full scan's worth of work on a churned store.
- **Recovery** (untested): a copy that does store rows a node owns (a clone, or rows written while nodes
  disagreed on ownership) takes the same path, so the keeper would be re-sent them.
- **When a base copy happens:** when a peer has no resume cursor for this source (a join, a clone, an
  interrupted first copy), or when it has fallen behind the retained audit log
  (`shouldForceBaseCopyForRetention`). A reconnect with a resume cursor resumes incrementally (read
  from the source, not exercised here).

### Traps

- **Seed and write through the component, not the operations API.** In a manual probe (output not kept),
  an `upsert` operation stored every row on the node it ran on, owner or not. Writes through the
  component's own table (REST, or code on a worker thread) followed residency. **Hypothesis:** the
  operation ran on a thread where the component's `setResidencyById` was never installed.
- **The mailbox holds one command.** `driver.mjs` serializes calls per node; two concurrent calls would
  overwrite each other and the first would wait out its timeout.
- **A kick must not delete.** An earlier version kicked with a put and a delete of a sentinel row. The
  resulting tombstone made every join re-send the whole table, which first read as a commit effect.

## Not covered

- More than two nodes, and a membership change that moves ownership (production's rendezvous list
  grows when a node joins; this harness fixes it at two).
- A churned, production-sized store: both harnesses start fresh, so absolute costs are floors.
- A keeper restart on a live node: the rebuild scan while writes and replication continue.
- Live deletes, and bulk batched writes (the single-node batch arm was contaminated by replayed events).
