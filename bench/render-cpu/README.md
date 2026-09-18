# `bench/render-cpu` — where a render's time and CPU actually go

> ## READ THIS BEFORE QUOTING ANY NUMBER BELOW
>
> **The absolute milliseconds are this fixture's, on one laptop. The SPLIT is the result.** What
> travels between this bench and production is the shape: which part of a render is wall-clock
> waiting that we impose, which part is Chrome working, and which parts are rounding errors. The
> per-render totals do not travel — a real PDP runs a framework, hydrates, and executes orders of
> magnitude more of its own script than this fixture does (**21 ms** of `ScriptDuration` here,
> whole-render).
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
`props` attributes, and perpetual cosmetic churn. Served from 127.0.0.1, so there is no origin, no
CDN and no network jitter in any number.

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

### The three instruments, and how each one lies

| instrument | what it sees | how it lies |
| --- | --- | --- |
| `cdpCounter` (patched `Connection` prototype) | every CDP message, by method | a message count is not a cost |
| `Performance.getMetrics` via puppeteer's own session | main-thread time split into script / layout / style / **DevToolsCommand** / other | main thread only — misses compositor, raster, network threads |
| `processTreeCpu` (`ps` over the Chrome process tree) | CPU seconds of every Chrome process and thread | attributes nothing |

Read together they cross-check: if main-thread task time falls but tree CPU does not, the work moved
threads rather than disappearing.

Two mechanical notes, both of which cost an hour to find:

- `page.metrics()` filters the result to a fixed allowlist and **drops `TaskOtherDuration`,
  `V8CompileDuration`, `DevToolsCommandDuration` and `ProcessTime`** — the four most useful
  counters. Opening a CDP session of your own does not help either: the Performance agent starts
  accumulating at `enable()`, so a session opened after the render reports idle microseconds. Read
  it through `page.mainFrame().client`, the session puppeteer enabled at page creation.
- Process-tree CPU must be sampled **while the page is still open** (from a `renderOnce` probe).
  Each render gets its own browser context, whose renderer process exits at teardown and takes its
  CPU accounting with it.

## Results

Full tables: `results/*.json` and the run logs. The summary that matters:

### On the fixture (controlled A/B, single render, idle machine)

| variant | wall | tree CPU | fidelity |
| --- | --- | --- | --- |
| baseline (390x844, settleUntilStable) | 7,450ms | 2,520ms | — |
| tall viewport (390x5000) | 3,381ms (-55%) | 1,560ms (-38%) | identical |
| frame-paced scroll pass | 3,137ms (-58%) | 1,580ms (-37%) | identical |
| all winners stacked | 1,733ms (-77%) | 1,170ms (-54%) | identical |

Settle split at baseline: **scroll 4,968ms + network-idle 1,503ms + counting 20ms + gating 24ms.**
91% of settle is two waits we impose; all in-page counting and gating together is **0.59%** of the
render.

### Under load (concurrency 8, 14 cores)

| variant | renders/s | vs baseline | CPU/render |
| --- | --- | --- | --- |
| baseline | 1.05 | 1.00x | 2,206ms |
| stacked winners | 4.07 | 3.88x | 1,358ms |
| images off in Blink | 1.07 | 1.02x | 1,973ms (-11%) |
| MutationObserver count monitor | 1.06 | 1.01x | 2,171ms |

At c=8 on 14 cores the machine is not yet CPU-saturated, so CPU-only wins understate; a saturated
pod converts them 1:1 into throughput.

### On real pages — and the correction that matters most

**The fixture numbers above were measured against a baseline the fleet had already left behind.**
Tall viewports on every device and per-page-type settle profiles had already shipped on the consumer
branch. Re-based on the live deployed config, a real mobile PDP costs **4,050ms / 4,600ms CPU**, not
the 13,621ms an out-of-date config measured — and the remaining headroom is correspondingly smaller.

What is left, measured on four real pages (two PDPs, a populated catalog page, an empty-facet
catalog page), median of 4 reps, against the deployed config:

| variant | PDP wall | catalog wall | PDP CPU | catalog CPU |
| --- | --- | --- | --- | --- |
| skip the pre-gate plateau | -14% | -18% | -9% | -14% |
| skip `topSettleMs` before a plateau | -4% | -14% | -5% | -11% |
| skip the network-idle sleep alone | **+10%** | -7% | +6% | -4% |
| all four blind waits removed | **-23%** | **-39%** | **-13%** | **-30%** |

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
preserved fidelity exactly; none of them bought anything.

| candidate | result | why it cannot work |
| --- | --- | --- |
| fold the DOM count into the scroll-pass call | **+31% wall** | the loop then decides a pass late, so it runs a 4th scroll pass — which costs ~1.6 s to save one ~1 ms round trip |
| install the in-page helpers once at document start | 0% wall, `ScriptDuration` 21→33 ms | there is no per-call compile cost to recover: `V8CompileDuration` is **0 ms** across every variant |
| count with native `querySelectorAll` + a shadow-root registry | count 20→6 ms, 0% wall | a 14 ms saving inside a 7,450 ms render |
| MutationObserver monitor maintaining the count incrementally | count 20→3 ms, 0% wall | same: the walk was never expensive at this DOM size |
| existence short-circuit for `minCount: 1` gates | 0% wall | the gate is 24 ms total, and it satisfies on its first tick |
| combine the two waitFor calls per tick | gate 24→12 ms, 0% wall | the anchor exists in the served HTML, so the pre-scroll tick happens once |
| `domStablePollMs` 250 → 60 | 0% wall | nothing in this config polls in a loop long enough to care |
| share one browser context across renders | 0% wall, −3% CPU (noise) | per-render context/process cost is not measurable at this render length |
| `prefers-reduced-motion` | 0% wall, −8% CPU | the animation work was never on the critical path |
| abort blocked images instead of stubbing them | **fidelity loss** | the 1×1 stub is load-bearing: it fires `load`, and content gated on an image's load event disappears without it |

## Scaffolding to remove before this ships

`packages/browser/src/experiments.ts` and the `experiments.*` branches in `renderer.ts` exist ONLY
so a candidate and the code it replaces can be measured in one process. Whatever wins becomes
unconditional and the flag is deleted; `src/inPage.ts` goes with it unless the helper install turns
out to be worth keeping for another reason. The `window.__passes` counter in the scroll functions is
bench scaffolding too. If any of it is still in the tree when the work lands, the work is not done.
