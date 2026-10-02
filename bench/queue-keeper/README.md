# `bench/queue-keeper` — what an in-memory queue keeper would cost

Prices "design C" for exposing queue state: one thread per node keeps the render queue in memory, fed
by a subscription on `RenderSchedule`, instead of walking the `nextRenderTime` index. It measures the
two things that decide whether that is viable: the **subscription's cost per write** and the
**keeper's memory**. It also checks that the in-memory copy stays exactly equal to the table.

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
- **Replay after a gap (observed, mechanism not confirmed).** Suppose a thread's subscriptions all
  end and a new one starts later. The new one receives every row written in between, with its
  current value: about 45k extra events after each `none` arm here. That's harmless to a keeper
  (applying a row twice changes nothing), and it means subscribe-then-scan cannot miss a write. It
  does inflate cost figures, so the harness counts these separately (`replayedFromBeforeArm`).
- **A replication base copy** (`reload`) makes Harper re-deliver the whole table as puts.

## Not covered

- Writes replicated from another node (single-node container).
- A churned, production-sized store.
- Bulk batched writes: the batch arm was contaminated by replayed events.
