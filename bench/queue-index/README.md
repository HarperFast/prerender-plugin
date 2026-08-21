# `bench/queue-index` — what the render queue's storage actually costs

Every scheduling decision in this package is justified by a number, and the two numbers the queue
design rests on **cannot be reproduced**: prerender-plugin#80 cites `20-lanesim.mjs` and
`21-duerank.mjs`, neither of which is in this repository. This harness exists so the next schema
change is argued from figures anyone can regenerate.

It also exists because the two figures currently in the tree **disagree by 80x**:

| source | claim | implied |
| --- | --- | --- |
| `src/util/renderSchedule.js` | the claim scan returns 20 keys in 0.43 ms | ~21 µs/row |
| `src/util/backlogSnapshot.js` | "~3.5s per 2,000 rows" | ~1.75 ms/row |

Both describe a one-sided ascending range read over the same index on the same table, and which one
is right decides the architecture:

- At **21 µs/row**, streaming the whole due set through a bounded heap once a minute costs ~30 s of
  background work on a 1.6M-row corpus. A "buffer everything due now and sort it there" design is
  viable, and ordering can be exact.
- At **1.75 ms/row**, a 500k-row due set takes ~15 minutes to walk. Every design that reads the due
  set is dead, and priority has to be expressed in the index itself.

The likely reconciliation is that `backlogSnapshot` yields to the event loop every 200 rows *beside
bot traffic* and seeks the absolute index minimum, while the claim scan seeks a floor and never
yields — so the harness measures yielding as an explicit variable rather than assuming it.

## Running it

```bash
BENCH_MODE=docker ROWS=200000 ./run.sh
```

Docker mode mirrors how kohls-pr's CI stands Harper up. `BENCH_MODE=local` uses an installed root
under `$BENCH_ROOT` instead. Either way it must be an **isolated** Harper: the harness writes
hundreds of thousands of rows, and it refuses to run against `~/hdb`.

`ROWS` defaults to 200,000 to match #80 so the numbers are comparable. Production is 1,619,000 keys
(814,200 targets × 2 device types) — per-row costs are what transfer, not totals.

Docker mode is the verified path (Harper 5.2.4, `ROWS=200000`). Two things about it are worth
knowing before you edit the harness:

- The component is **staged into a temp dir and mounted read-write.** Harper's component loader
  creates `node_modules` inside the component directory to symlink the `harper` module, so a
  read-only mount fails the component with `EROFS` — and the server then comes up perfectly happy
  having loaded nothing.
- The entry point is **`jsResource`, not `pluginModule`.** `handleApplication` is the hook Harper
  calls on a component another component *uses* as an extension; a root component declaring it is
  simply never invoked. Same silent-success failure.
- Harper **intercepts `process.exit`**, so the harness signals itself instead.

## What it answers, and what each answer decides

| | question | if the answer is… | then |
| --- | --- | --- | --- |
| Q1 | per-row cost of the claim-shaped read at limits 20 → 20,000 | small (~tens of µs) | a background sweep of the due set is affordable; exact ordering is on the table |
| | | large (~ms) | priority must live in the index; no design may read the due set |
| Q2 | how much of Q1 is the yielding, not the engine | yielding dominates | the 80× is an artefact and Q1's plain number is the real one |
| Q3 | K per-lane seeks vs one large seek | per-lane ≈ free | the interleaved-lane design in #116 is sound |
| Q4 | single-attribute update vs whole-record `put` | update much cheaper | an in-place lane change is cheap; encoding is a good deal |
| Q5 | one indexed attribute vs two, on the write | ≈ equal | #80's "a second index doubles the hot write" is wrong, and a per-lane **table** becomes viable |
| | | two much slower | splitting `dueAt` out of the queue key must keep `dueAt` **unindexed** |
| Q6 | two-sided vs one-sided range, limit fillable and not | two-sided catastrophic when it cannot fill | keep the `<= now` half in application code, as `claimSchedules` does |
| Q7 | does the seek point degrade as rows churn away from it | yes, and a floored seek is immune | the claim floor stays load-bearing under any new design |

Q4 and Q5 together decide the change I'd otherwise make on correctness grounds alone: giving the
queue its **own** indexed column and leaving the freshness deadline as a plain unindexed timestamp,
so nothing outside the funnel ever has to decode a due time.
