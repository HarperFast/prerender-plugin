# `bench/render-cpu` — where a render's time and CPU actually go

> ## READ THIS BEFORE QUOTING ANY NUMBER BELOW
>
> **The absolute milliseconds are this fixture's, on one laptop. The SPLIT is the result.** What
> travels between this bench and production is the shape: which part of a render is wall-clock
> waiting that we impose, which part is Chrome working, and which parts are rounding errors. The
> per-render totals do not travel — a real PDP runs a framework, hydrates, and executes orders of
> magnitude more of its own script than this fixture does (**40 ms** of `ScriptDuration` here
> whole-render, ~150 ms at `?chunks=69`, against 800–2,465 ms measured on real customer pages).
>
> Two numbers that DO travel, because they are products of our own code and the page height rather
> than of the site's JavaScript:
>
> - a scroll pass is `ceil(height / viewportHeight)` steps, each waiting `scroll.stepMs`. At the
>   deployed mobile profile (390×844, `stepMs: 60`) over an 18,358 px page that is 22 steps × 60 ms ×
>   3 passes = **3,915 ms of pure `setInterval` waiting**, and the measured scroll total was 4,968 ms.
> - the per-pass `waitForNetworkIdle` window is `networkIdleMs` per pass, floor, and 3 passes cost
>   **1,503 ms**.
>
> Together: **91% of settle, and 87% of the whole render, is our own two waits.** Chrome's own
> accounting agrees it is not busy — 2.65 s of process-tree CPU across a 7.45 s render.
>
> ### Two more that travel, and they are what you size a pod from
>
> Measured under load against an external fixture, 3 reps, medians (see [§Under load](#under-load)).
> Neither is about this fixture's JavaScript, so neither is fixture-specific:
>
> - **RSS is ~265 MB per concurrent render slot, and it is linear** — 535 MB at c=1, 2,611 MB at
>   c=8, 5,023 MB at c=16, 7,422 MB at c=24 (R²≈1). **Nothing measured in this bench moves it**:
>   every cache candidate landed inside 2,588–2,631 MB at c=8. On a memory-sensitive fleet this,
>   not cores, is what sizes a pod.
> - **Splitting slots across worker PROCESSES costs 7–14% more RSS for no throughput.** At equal
>   total slots: 1×12 = 1.55/s at 3,788 MB, 2×6 = 1.56/s at 4,057 MB, 3×4 = 1.55/s at 4,305 MB. At
>   24 slots, 1×24 = 2.49/s at 6,833 MB vs 4×6 = 2.61/s at 7,572 MB — and that +5% is inside the
>   rep spread ([2.50, 2.49, 2.18] vs [2.67, 2.61, 2.44]). Each extra process is another Node heap
>   and another Chrome browser. **The multi-process worker shape is not a throughput optimisation
>   on this workload.** Whatever justifies it — blast radius, a wedged browser taking down fewer
>   slots, per-process memory ceilings — is not a throughput argument, and at a memory-bound sizing
>   it is a small throughput COST.
>
> ### The concurrency knee below is a LAPTOP ARTIFACT — do not carry it to the fleet
>
> Throughput is linear to c=12, then 86% of linear at c=16 and 83% at c=24, and per-render
> CPU-SECONDS rise 11–14% over the same range. It is tempting to read that as a concurrency limit.
> It is not one:
>
> - total CPU utilisation at the knee is **25%** (c=12) rising to 49% (c=24) — nothing is saturated;
> - the driver's event loop is **10% busy** with a p99 lateness of 31 ms in an 8.9 s render, so it is
>   not our thread either;
> - splitting the same slots across processes does not fix it.
>
> This machine is an **Apple M4 Pro: 10 performance cores + 4 much slower efficiency cores**, not 14
> equal ones. The knee sits exactly where concurrent renderers start landing on E-cores, which
> inflates CPU-seconds for identical work without saturating anything. A pod with homogeneous cores
> should not have this knee. **"Concurrency 12" is this laptop's core topology, not a fleet limit.**
> (Not proven with per-core sampling — it is the explanation that fits every other measurement.)
>
> **The thing this bench was built to evaluate turned out to be noise.** It was commissioned to test
> "can we make fewer CDP calls, maybe combine some `evaluate` calls". Measured: `Runtime.callFunctionOn`
> is **15 calls of 435** CDP messages per render, and every in-page count and gate check TOGETHER is
> **44 ms — 0.59% of the render**. Six separate candidate optimisations of that code (combining calls,
> installing helpers once, native counting, a MutationObserver monitor, existence short-circuits,
> finer polling) all measured within noise of baseline, several slightly WORSE. They are recorded
> below as dead ends so nobody spends another day on them.

## What it measures

One deterministic, self-contained page ([fixture.js](fixture.js)) shaped like a commerce PDP —
~21,900 light-DOM elements, 18,358 px tall, 12 open shadow roots with their own stylesheets, 3,000
utility CSS rules of which most never match, IntersectionObserver-lazy grid sections, a review
widget that appears only after its anchor intersects, a three-state reveal wrapper, `astro-island`
`props` attributes, and perpetual cosmetic churn. It also serves **real script bundles** — 9 of
~113 KB, each a few hundred real functions that V8 has to fetch, compile and run — because without
them no caching or compile-cost candidate is measurable at all. `?chunks=N` raises the sub-resource
count to production shape (~70 per render) **without touching the DOM, the CSS or the page height**,
so every other number stays comparable. Served from 127.0.0.1, so there is no origin, no CDN and no
network jitter in any number — which also means this bench **cannot price a network round trip**,
and that is the one thing a resource cache exists to save.

Each variant renders it through the real `renderOnce` → `defaultRenderer` path with a config
mirroring the deployed render-service one, and is measured on three instruments at once
([instrument.js](instrument.js)) plus a wall-clock split of the settle phase.

```bash
node bench/render-cpu/bench.js                                  # all variants, mobile, 5 reps
node bench/render-cpu/bench.js --device desktop --reps 7
node bench/render-cpu/bench.js --only baseline,best-of --reps 9
node bench/render-cpu/bench.js --json bench/render-cpu/results/mobile.json
```

Variants are **interleaved** (rep 1 of every variant, then rep 2) because a laptop's clock drifts
with thermals over the ~15 minutes a full sweep takes, and a block layout would hand the whole
drift to whichever variant ran last. Reported as **medians**. One warm-up rep per variant is
discarded.

### The four instruments, and how each one lies

| instrument                                                          | what it sees                                                                                                                                                                              | how it lies                                                                                                                                 |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `cdpCounter` (patched `Connection` prototype)                       | every CDP message, by method                                                                                                                                                              | a message count is not a cost                                                                                                               |
| `Performance.getMetrics` via puppeteer's own session                | main-thread time split into script / layout / style / **DevToolsCommand** / other                                                                                                         | main thread only — misses compositor, raster, network threads                                                                               |
| `processTreeCpu` (`ps` over the Chrome process tree)                | CPU seconds and RSS of every Chrome process, bucketed by Chrome's own `--type=` — renderer / gpu-process / utility:network / browser — and the number of distinct `--renderer-client-id`s | a bucket is not a call stack; and `ps TIME` has 10 ms per-process resolution, so at c=1 the small buckets carry ±10 ms                      |
| `process.cpuUsage()` + `monitorEventLoopDelay` ([load.js](load.js)) | the DRIVER's own CPU and event-loop lateness — the bench process is a process too                                                                                                         | loop delay is ABSOLUTE lateness, so an idle process already reads about its own resolution (11 ms here); read it as a delta from that floor |

Read together they cross-check: if main-thread task time falls but tree CPU does not, the work moved
threads rather than disappearing.

<a id="under-load"></a>

### Under load — [load.js](load.js), [fleet.js](fleet.js), [uvsweep.js](uvsweep.js)

`bench.js` answers "how long is one render and where does its wall-clock go". `load.js` answers
"renders/second and CPU-seconds/render at a given concurrency", which is what decides how much fleet
a traffic level needs.

```bash
node bench/render-cpu/fixture-server.js --port 58200 &   # REQUIRED above c≈8 — see below
F=http://127.0.0.1:58200/product/prd-bench
node bench/render-cpu/load.js --concurrency 8 --reps 3 --fixture $F
node bench/render-cpu/load.js --concurrency 1,2,4,8,12,16,24 --only baseline --reps 3 --fixture $F
node bench/render-cpu/load.js --only context-pool --trace --batches 6    # the warm-up curve
node bench/render-cpu/fleet.js --shapes 1x12,2x6,3x4,1x24,4x6 --reps 3   # process shape
node bench/render-cpu/uvsweep.js --sizes 4,16,32 --reps 3                # one child per setting
node bench/render-cpu/aging.js --batches 60 --concurrency 4              # does an aged browser slow down?
```

[aging.js](aging.js) answers a different question from the other two and is documented in its own
header: it keeps one browser alive for hundreds of pages and records every render in order, to test
whether `browserExpirationThreshold` (retire at 200 pages) is buying anything. **It was started and
stopped at 60 of 240 renders per arm — its result is INDETERMINATE, not negative.** See
[§Does an aged browser get slower](#does-an-aged-browser-get-slower-unfinished).

A UNIT is `(concurrency, variant, rep)`: its own browser, `--warmups` discarded batches, then one
measured batch. Units are **interleaved rep-major**, for the same thermal reason as `bench.js`. A
browser per unit rather than per variant is what makes the cache candidates honest — every variant
starts from a cold Chrome and gets exactly `--warmups` batches to warm whatever it can.

**Run the fixture in its OWN process above c≈8.** `startFixture()` serves HTTP on the CALLER's event
loop, so in-process at c=24 one Node thread was serving ~9,600 responses (including the ~113 KB
bundles) while also driving 24 renders' CDP traffic and every interception callback. Moving it out
changed the c=24 row by **−22% batch / +27% renders/s** and left c≤16 untouched. Production's origin
is a different machine; an in-process fixture is not, and a ladder run that way finds the harness.

### Four hazards, each of which produced a wrong number before it was found

- `page.metrics()` filters the result to a fixed allowlist and **drops `TaskOtherDuration`,
  `V8CompileDuration`, `DevToolsCommandDuration` and `ProcessTime`** — the four most useful
  counters. Opening a CDP session of your own does not help either: the Performance agent starts
  accumulating at `enable()`, so a session opened after the render reports idle microseconds. Read
  it through `page.mainFrame().client`, the session puppeteer enabled at page creation.
- Process-tree CPU must be sampled **while the page is still open**, AND the "before" sample must
  wait for the process count to stop moving. `after − before` is only a CPU measurement while every
  process alive at `before` is still alive at `after`; a batch that just closed its pages leaves
  renderer processes exiting asynchronously, and sampled too early they are counted in `before` and
  gone by `after`. That flatters whichever variant tears down the MOST processes — which is exactly
  the baseline-vs-pooled-context comparison this file exists for.
- **`V8CompileDuration` cannot see compile work; `processTreeCpu` is the only instrument that can.**
  It reads **0.22 ms whole-render against ~1 MB of script bundles**. That is not "nothing was
  compiled": V8 compiles lazily and streams/compiles on background threads inside the renderer, and
  this counter is main-thread compile only. Any inference of the form "compile is free because
  `V8CompileDuration` is 0" is wrong — including the one that used to be in the dead-end table
  below. Use `ScriptDuration` (compile + execute, main thread) and tree CPU.
- **A config that changes between renders in one process may silently not take effect.**
  `resolveConfigForJob` caches resolved configs by a signature of the device plus the ordered names
  of the matching overrides, and drops that cache only when the **identity of the
  `config.overrides` ARRAY** changes. A variant that spreads a base config and adds a field — which is exactly what a
  bench variant does — keeps the same `overrides` array, so every URL that MATCHES an override
  resolves to the PREVIOUS render's cached config. Measured cost: a live contract sweep reported "no
  contract matched" on four of five pages; the fifth worked only because it matches no override at
  all (`applied.length === 0` returns the base config and bypasses the cache), which is also why the
  failure looks like a page-specific problem rather than a caching one. **In a bench, give each
  variant a fresh `overrides` array so the identity check fires.** It is also worth fixing upstream:
  production happens to be safe only because a config reload reparses JSON and so produces a new
  array, and nothing enforces that — any path that changes the base config while reusing the same
  overrides array serves stale resolved configs with no signal.

## Results

Full tables: `results/*.json` and the run logs. The summary that matters:

### On the fixture (controlled A/B, single render, idle machine)

| variant                               | wall           | tree CPU       | fidelity  |
| ------------------------------------- | -------------- | -------------- | --------- |
| baseline (390x844, settleUntilStable) | 7,450ms        | 2,520ms        | —         |
| tall viewport (390x5000)              | 3,381ms (-55%) | 1,560ms (-38%) | identical |
| frame-paced scroll pass               | 3,137ms (-58%) | 1,580ms (-37%) | identical |
| all winners stacked                   | 1,733ms (-77%) | 1,170ms (-54%) | identical |

Settle split at baseline: **scroll 4,968ms + network-idle 1,503ms + counting 20ms + gating 24ms.**
91% of settle is two waits we impose; all in-page counting and gating together is **0.59%** of the
render.

### Under load, round 1 (concurrency 8) — the settle candidates

| variant                        | renders/s | vs baseline | CPU/render     |
| ------------------------------ | --------- | ----------- | -------------- |
| baseline                       | 1.05      | 1.00x       | 2,206ms        |
| stacked winners                | 4.07      | 3.88x       | 1,358ms        |
| images off in Blink            | 1.07      | 1.02x       | 1,973ms (-11%) |
| MutationObserver count monitor | 1.06      | 1.01x       | 2,171ms        |

At c=8 the machine is nowhere near CPU-saturated — 1.05/s × 2.2 s is 2.3 of 14 cores — so CPU-only
wins understate here; a saturated pod converts them 1:1 into throughput.

### Slot-scoped contexts, the two HTTP caches, and the V8 code cache

Every render has always taken a fresh incognito context, whose HTTP cache is in-memory and dies with
it. `load.js` leases a long-lived context per SLOT instead and wipes it between renders with
`resetForNextVariant` — the same routine production already uses between a job's device variants,
which fails closed. c=8, 3 reps, 2 warm-up batches, medians; rep spread in brackets.

| variant                                            | batch   | CPU/render                 | renders/s | `ScriptDuration` | origin req/render | rssMb |
| -------------------------------------------------- | ------- | -------------------------- | --------- | ---------------- | ----------------- | ----- |
| baseline                                           | 7,580ms | 2,261ms [2200, 2261, 2313] | 1.06      | 40ms             | 12                | 2,631 |
| slot-scoped context (incognito)                    | 7,560ms | 2,215ms [2180, 2215, 2273] | 1.06      | 40ms             | **0**             | 2,623 |
| resource cache on                                  | 7,615ms | 2,149ms [2148, 2149, 2233] | 1.05      | 40ms             | 1                 | 2,623 |
| both caches                                        | 7,576ms | 2,136ms [2134, 2136, 2139] | 1.06      | 41ms             | 0                 | 2,601 |
| **default context + persistent `--user-data-dir`** | 7,569ms | 2,130ms [2093, 2130, 2153] | 1.06      | **24ms**         | 0                 | 2,588 |
| default context, temp profile                      | 7,588ms | 2,156ms [2150, 2156, 2209] | 1.05      | **24ms**         | 0                 | 2,598 |

Four findings, and only the second is worth acting on:

1. **The pooling mechanism works and costs nothing.** Origin fetches fall **12/render → 0/render**
   after one warm-up batch; the wipe never failed in ~400 renders; RSS is unchanged. But the CPU
   difference against baseline is **inside noise** — 2,215 vs 2,261 is −2% against a baseline rep
   spread of 113 ms. Report it as "no measurable CPU difference", not as −2%.
2. **The V8 code cache needs the DEFAULT context, not a pooled incognito one.** `ScriptDuration`
   stays at 40 ms with a pooled incognito context and drops to **24 ms (−40%)** with the default
   context — with or without a persistent profile. The code cache lives in Chrome's disk-cache
   backend, and an incognito context's cache is in-memory by construction, so it never gets one.
3. **A persistent `--user-data-dir` therefore REPLACES the context pool rather than composing with
   it.** It buys nothing for pooled incognito contexts; the −40% comes from `incognitoPages: false`,
   and the persistent profile only adds survival across browser RESTARTS (a temp-profile default
   context already reached 24 ms within one browser lifetime).
4. **This fixture cannot size the win.** Its whole script budget is 40 ms of a 7,500 ms render, so
   even a perfect code cache is worth 0.2% here.

**On real pages it is worth having.** Measured on a live product page against incognito-per-render:
**−11% wall, −9% CPU, −28% `ScriptDuration`** — and the isolation wipe is FREE, because
`Storage.clearDataForOrigin` does not clear the HTTP disk cache, so the wiped arm matched the
unwiped one. **The open blocker is isolation at CONCURRENCY, not performance**: the default context
shares one cookie jar across every concurrent render, which is what `documentReuse.cookies.pin` and
[variantContext.ts](../../packages/browser/src/variantContext.ts) exist to prevent. That routine was
designed for a job's device variants rendered in SEQUENCE; proving a per-render wipe is sufficient
when renders OVERLAP is a different argument and has not been made.

### Is the resource cache a net win? At production resource counts, no

`?chunks=69` — 70 cacheable sub-resources per render, production shape. c=8, external fixture, 3
reps, 2 warm-ups.

| variant             | batch                          | Chrome CPU/render | Node CPU/render | Node busy | origin req/render | rssMb |
| ------------------- | ------------------------------ | ----------------- | --------------- | --------- | ----------------- | ----- |
| no cache (control)  | **7,845ms** [7833, 7845, 8027] | 2,429ms           | **44ms**        | 4%        | 73                | 2,909 |
| resource cache on   | 8,021ms [8001, 8021, 8076]     | **2,359ms**       | **93ms**        | 9%        | 1                 | 2,850 |
| slot-scoped context | 7,923ms [7767, 7923, 7946]     | 2,521ms           | **43ms**        | 4%        | **0**             | 2,953 |
| both                | 8,005ms [8005, 7986, 8071]     | 2,364ms           | 92ms            | 9%        | 0                 | 2,845 |

- **Our resource cache does not remove CPU — it MOVES CPU out of Chrome and onto the single Node
  thread.** Chrome-tree CPU falls 2,429 → 2,359 (−2.9%, mostly out of `utility:network`, 63 → 35 ms)
  while Node CPU per render **doubles, 44 → 93 ms**, and the loop goes 4% → 9% busy. Net per render:
  2,473 ms vs 2,452 ms — a wash. That is the cost of replaying bodies base64-encoded through
  `Fetch.fulfillRequest`, and it lands on the scarcest thread in the process.
- **It also makes the render 2.2% SLOWER here** (7,845 → 8,021 ms, rep ranges barely overlapping).
- **Chrome's own cache achieves the same origin offload for free** — 0 requests with Node CPU
  unchanged at 43 ms — and with both on they are redundant (2,364 vs 2,359): ours answers first.

**The caveat is load-bearing and this bench cannot lift it: the origin is localhost.** The thing a
resource cache exists to save is a network round trip, and here that round trip is ~0 ms. At a real
origin's 20–100 ms RTT × 70 resources the sign flips. What IS settled is the part that is not about
latency: our cache costs ~50 ms of extra Node main-thread CPU per render to give back ~70 ms of
Chrome CPU, and Chrome's own cache does the offload at zero Node cost — but only within one slot's
browser lifetime, where ours is shared across slots, processes and restarts.

### Does an aged browser get slower? (UNFINISHED — 25% of the intended run)

The fleet retires a browser after 200 opened pages (`browserExpirationThreshold`, checked as
`browser.totalOpenedPages > BROWSER_MAX_TOTAL_PAGES` in `Worker.ts`). The reason on record is a
general "prevent memory leaks" recommendation plus an operator impression; it has never been
measured. [aging.js](aging.js) was built to measure it and the run was stopped early, at **60 of the
intended 240 renders per arm**. What follows is three sample points per arm and **cannot support a
verdict either way** — it is recorded so a later attempt starts from data rather than from nothing.

Four arms, interleaved batch-by-batch against simultaneously live browsers (so thermal drift, which
looks exactly like aging, hits every arm equally), c=4, external fixture. Each cell is one batch's
median, not a band median:

| arm                                  | page 20                         | page 40               | page 60               |
| ------------------------------------ | ------------------------------- | --------------------- | --------------------- |
| fresh-incognito (today's shape)      | 7,460ms / 2,187ms CPU / 1,430MB | 7,456 / 2,160 / 1,434 | 7,450 / 2,383 / 1,447 |
| pooled-incognito                     | 7,467 / 2,260 / 1,430           | 7,451 / 2,173 / 1,436 | 7,462 / 2,270 / 1,439 |
| pooled-recycle                       | 7,463 / 2,202 / 1,426           | 7,461 / 2,220 / 1,434 | 7,462 / 2,495 / 1,436 |
| persist-default (persistent profile) | 7,478 / 2,262 / 1,418           | 7,472 / 2,395 / 1,425 | 7,466 / 2,327 / 1,426 |

- **Wall is flat to 0.2% in every arm** over the first 60 pages — including the two that accumulate
  state. Whatever aging is, it is not visible in wall-clock this early.
- **CPU is non-monotonic in three of four arms** and every value sits inside the batch-to-batch
  spread measured independently at this concurrency (~±5%). No signal.
- **RSS rises ~1% per 40 pages in ALL FOUR arms, including the control** that creates and destroys a
  browser context every render. A drift the control shares is not context accumulation, and at this
  slope it is nowhere near a reason to retire at 200. Three points is not a curve, and this is the
  one number worth re-measuring properly.

**One real finding did come out of it, and it is about the wipe, not about aging.**
`resetForNextVariant` with an EMPTY cookie jar costs **1–2 ms on an incognito context and ~20 ms on
the default context of a persistent profile** — a 10–20× gap before a single cookie exists, so it is
`Storage.clearDataForOrigin` touching a disk-backed profile rather than an in-memory one. At 20 ms
that is 0.27% of a render here and would not decide anything on its own, but it is a cost that
belongs to the persistent-profile candidate specifically, and it is the floor: puppeteer issues one
`Network.deleteCookies` per cookie, and a real storefront handed over 125. (Measured over a 2-batch
smoke run — small n, large effect.) The fixture's `?cookies=N` knob and the `wipe-0` / `wipe-25` /
`wipe-125` arms exist to price that scaling and **were never run**.

### The concurrency ladder, and what process shape buys

Baseline, external fixture, 3 reps. **Read the knee caveat at the top of this file before quoting
any of it.**

| conc | batch   | per-render | CPU/render | renders/s | vs linear | Node CPU/render | Node busy | loop p99 | rssMb |
| ---- | ------- | ---------- | ---------- | --------- | --------- | --------------- | --------- | -------- | ----- |
| 1    | 7,420ms | 7,420ms    | 2,500ms    | 0.13      | 100%      | 60ms            | 1%        | 11.1ms   | 535   |
| 2    | 7,449ms | 7,448ms    | 2,430ms    | 0.27      | 100%      | 37ms            | 1%        | 11.2ms   | 841   |
| 4    | 7,475ms | 7,468ms    | 2,175ms    | 0.54      | 100%      | 24ms            | 1%        | 11.2ms   | 1,430 |
| 8    | 7,573ms | 7,553ms    | 2,225ms    | 1.06      | 98%       | 21ms            | 2%        | 11.4ms   | 2,611 |
| 12   | 7,701ms | 7,663ms    | 2,221ms    | 1.56      | 96%       | 18ms            | 3%        | 15.2ms   | 3,786 |
| 16   | 8,606ms | 7,802ms    | 2,475ms    | 1.86      | **86%**   | 51ms            | 10%       | 15.0ms   | 5,023 |
| 24   | 8,908ms | 8,125ms    | 2,530ms    | 2.69      | **83%**   | 38ms            | 10%       | 31.3ms   | 7,422 |

CPU-seconds/render is **flat from c=2 to c=12** (2,175–2,430 against a within-variant rep spread of
~±120 ms), then rises 11% at c=16 and 14% at c=24. Throughput does not hard-plateau, it rolls off —
doubling 12→24 still buys +72%.

Per-process split, the same run: **the renderer is 90% of tree CPU at c=1 and 93% at c=8**
(c=8: renderer 2,091 ms, gpu-process 70 ms, browser 53 ms, utility:network 23 ms, per render). No
out-of-process-iframe blow-up — the process count is exactly `concurrency + 4` at every level from 1
to 24, and the distinct `--renderer-client-id` count tracks it. The GPU process still burns
70–130 ms/render **despite `--disable-gpu` and `--disable-software-rasterizer`**: small, but not
zero, and pure overhead for a headless snapshot.

Process shape at equal total slots (3 reps) is in the block at the top of this file: **1×12, 2×6 and
3×4 are indistinguishable at 1.55–1.56/s, and splitting costs 7–14% more RSS.**

### On real pages — and the correction that matters most

**The fixture numbers above were measured against a baseline the fleet had already left behind.**
Tall viewports on every device and per-page-type settle profiles had already shipped on the consumer
branch. Re-based on the live deployed config, a real mobile PDP costs **4,050ms / 4,600ms CPU**, not
the 13,621ms an out-of-date config measured — and the remaining headroom is correspondingly smaller.

What is left, measured on four real pages (two PDPs, a populated catalog page, an empty-facet
catalog page), median of 4 reps, against the deployed config:

| variant                             | PDP wall | catalog wall | PDP CPU  | catalog CPU |
| ----------------------------------- | -------- | ------------ | -------- | ----------- |
| skip the pre-gate plateau           | -14%     | -18%         | -9%      | -14%        |
| skip `topSettleMs` before a plateau | -4%      | -14%         | -5%      | -11%        |
| skip the network-idle sleep alone   | **+10%** | -7%          | +6%      | -4%         |
| all four blind waits removed        | **-23%** | **-39%**     | **-13%** | **-30%**    |

The settle budget on the deployed profile closes to within ~50ms as: scroll 72 + networkIdle 500 +
`topSettleMs` 300 + plateau ~850 + gate ~2 + `topSettleMs` 300 + plateau ~850. **Every one of those
except the gate is a blind Node-side sleep**, and `networkIdleMs` equals `networkIdleTimeoutMs` on
this profile, so the idle call can never observe its window — it is structurally a fixed sleep.

**Waits are fungible, which is why the single-lever rows mislead.** Removing the idle sleep ALONE
made the PDP 10% slower: the plateau that follows simply waited longer (+75%), because the page was
still changing. Removing a blind wait only pays when a later, content-conditional wait does not
absorb it. That is why the stacked row is not the sum of its parts, and why the honest metric is
`settle - (gate + plateau time actually spent waiting for a change)`.

## The parity caveat on the real-page results

Structural markers held identically across every variant and page: review-node count (1,430 / 1,661),
JSON-LD blocks, `Offer` count, `<h1>`, island count, and — the hydration tripwire — zero
`ssr`-marked islands.

**But two markers are too noisy to support a parity claim: `<img>` count and product-link count.**
They moved +-5% between variants AND between reps of the SAME variant, non-monotonically (one page's
cheapest variant matched baseline exactly while a more conservative one was 18 links short, and a
variant that changes nothing about timing came back with MORE links than baseline). That is the site
serving different recommendation content per request, not us losing it. A parity verdict on those
needs a per-page churn floor measured from repeated same-variant renders — which is exactly what
`audit/reuseParity.ts` already implements. **Do not ship a settle change on the strength of the
table above alone.**

## What this cannot answer

**Whether any of these changes is faithful on a real site.** The fixture carries three deliberate
tripwires — content gated on an image's `load` event, content gated on a `scroll` EVENT (not an
observer), and the three-state review reveal — and the fidelity table above is checked on every
run. That catches the failure modes we thought of. It cannot catch:

- **Viewport-height-dependent layout and script.** A 5,000 px-tall mobile viewport makes `100vh`
  5,000 px, and any script that computes slide counts, sticky offsets or "is this in view" from
  `window.innerHeight` sees a different page. Desktop already renders at 1920×5000, so the site
  tolerates it there; mobile CSS is not the same CSS.
- **Fleet memory.** A taller viewport composites more area per step. This bench reports JS heap, not
  layer memory, and the fleet is already memory-sensitive — watch pod RSS after any viewport change.
- **Real hydration cost.** The fixture's own JS is 21 ms. Anything that changes WHEN we snapshot
  relative to a real framework's hydration has to be judged on a real render.

The gate for all of that already exists in this package and should be the next step for any change
here: `renderAudit` / `paintParity` / `reuseParity` against staging, per device.

## Dead ends — measured, do not re-propose

Each of these was implemented and measured against the same fixture in the same process. All of them
preserved fidelity exactly, and none of them bought any CPU or throughput — a couple do change
something else (origin fetches, memory), which the rows say explicitly.

| candidate                                                                               | result                                                                                                             | why it cannot work                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| fold the DOM count into the scroll-pass call                                            | **+31% wall**                                                                                                      | the loop then decides a pass late, so it runs a 4th scroll pass — which costs ~1.6 s to save one ~1 ms round trip                                                                                                                                                                                                                                                                                                                |
| install the in-page helpers once at document start                                      | 0% wall, `ScriptDuration` 21→33 ms                                                                                 | the source shipped per call is a few hundred bytes against a page that compiles ~1 MB of its own bundles; there is no per-call compile cost of that size to recover                                                                                                                                                                                                                                                              |
| count with native `querySelectorAll` + a shadow-root registry                           | count 20→6 ms, 0% wall                                                                                             | a 14 ms saving inside a 7,450 ms render                                                                                                                                                                                                                                                                                                                                                                                          |
| MutationObserver monitor maintaining the count incrementally                            | count 20→3 ms, 0% wall                                                                                             | same: the walk was never expensive at this DOM size                                                                                                                                                                                                                                                                                                                                                                              |
| existence short-circuit for `minCount: 1` gates                                         | 0% wall                                                                                                            | the gate is 24 ms total, and it satisfies on its first tick                                                                                                                                                                                                                                                                                                                                                                      |
| combine the two waitFor calls per tick                                                  | gate 24→12 ms, 0% wall                                                                                             | the anchor exists in the served HTML, so the pre-scroll tick happens once                                                                                                                                                                                                                                                                                                                                                        |
| `domStablePollMs` 250 → 60                                                              | 0% wall                                                                                                            | nothing in this config polls in a loop long enough to care                                                                                                                                                                                                                                                                                                                                                                       |
| `prefers-reduced-motion`                                                                | 0% wall, −8% CPU                                                                                                   | the animation work was never on the critical path                                                                                                                                                                                                                                                                                                                                                                                |
| abort blocked images instead of stubbing them                                           | **fidelity loss**                                                                                                  | the 1×1 stub is load-bearing: it fires `load`, and content gated on an image's load event disappears without it                                                                                                                                                                                                                                                                                                                  |
| **slot-scoped INCOGNITO context pool** (c=8, 3 reps)                                    | 2,215 ms vs 2,261 ms CPU/render (baseline spread 2200–2313), identical renders/s and RSS — but origin fetches 12→0 | it gets Chrome's HTTP cache and NOT the V8 code cache, because an incognito context's cache is in-memory and the code cache lives in the disk-cache backend. Ship it for origin offload if you want it; there is no CPU case. The CPU case belongs to the DEFAULT context — see [§Slot-scoped contexts](#slot-scoped-contexts-the-two-http-caches-and-the-v8-code-cache)                                                         |
| **`UV_THREADPOOL_SIZE` 4 → 16 → 32** (c=8 and c=16, resource cache on and warm, 3 reps) | within rep spread in both directions: c=8 renders/s 0.96 / 0.95 / 0.99, c=16 1.64 / 1.63 / 1.60                    | the mechanism is real — `cache.get()` is an `fs.readFile` on that pool while the request is PAUSED in Chrome — but it is nowhere near loaded: 70 reads/render at c=16 is ~114 reads/s of page-cached files, and `ResourceCache` does no gzip, so the pool serves only `readFile`/`writeFile`/`rename`/`mkdir`. The signature to watch for on the fleet is Node loop lag rising with cache-hit count, which `load.js` now reports |
| **more worker PROCESSES at equal total slots** (3 reps)                                 | 1×12 / 2×6 / 3×4 all 1.55–1.56/s; 1×24 2.49/s vs 4×6 2.61/s with overlapping rep ranges                            | the driver's event loop is only 15% busy at 24 slots in ONE process, so there is no per-loop bottleneck to relieve — and each extra process adds a Node heap and a Chrome browser, for 7–14% more RSS                                                                                                                                                                                                                            |

### Corrected — these rows used to say something stronger than the evidence

- **"share one browser context across renders — 0% wall, −3% CPU (noise), per-render context cost is
  not measurable"** was measured in a frame that could not contain its own mechanism: the resource
  cache was hard-disabled, the fixture served no real script bundles, and the runner disposed the
  shared context between reps. Re-measured with all three fixed, the mechanism is real (origin
  fetches 12→0) even though the CPU verdict on the incognito form survives. The claim that replaced
  it is in [§Slot-scoped contexts](#slot-scoped-contexts-the-two-http-caches-and-the-v8-code-cache),
  and it is about which KIND of context, not whether
  sharing works.
- **"`V8CompileDuration` is 0 ms across every variant"** was true and the inference from it was
  wrong. See the hazard list above: V8 compiles lazily on background threads and this counter is
  main-thread compile only, so 0 means the instrument cannot see it, not that no compilation
  happened.
- Any claim that `--disk-cache-size=1073741824` (in `DEFAULT_CHROME_ARGS`) does anything for a
  render is wrong, and always was: every render takes a fresh **incognito** context, whose cache is
  in-memory and capped independently, so that flag has never applied to a single production render.
  It starts applying the moment renders move to the default context.

## Scaffolding to remove before this ships

`packages/browser/src/experiments.ts` and the `experiments.*` branches in `renderer.ts` exist ONLY
so a candidate and the code it replaces can be measured in one process. Whatever wins becomes
unconditional and the flag is deleted; `src/inPage.ts` goes with it unless the helper install turns
out to be worth keeping for another reason. The `window.__passes` counter in the scroll functions is
bench scaffolding too. If any of it is still in the tree when the work lands, the work is not done.

`fixture-server.js`, `fleet.js` and `uvsweep.js` are NOT in that category — they are part of the
harness, and the first of them is required for any measurement above c≈8.
