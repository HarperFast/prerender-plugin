/**
 * Run work a request STARTS but does not wait for — a probe pass, a sweep, a purge, a sitemap walk —
 * in this module's own async context instead of the request's.
 *
 * WHY. Harper carries a request's transaction in the async context, and everything that request's
 * handler starts inherits it: `run().catch(...)` before `return json(...)` leaves the work running,
 * after the response, on the request's transaction — which Harper then closes and reaps. Every read the
 * work makes on it from then on throws `Operation aborted: Database closed during transaction get
 * operation` (the error comes from the RocksDB binding, with no JavaScript stack). Measured in Docker on
 * Harper 5.2.14: a change-probe pass started from `POST /prerender_admin/change-probe` lost 1 to 11
 * page reads per pass that way, each one a detected change not acted on until the next pass. The same
 * pass started here lost none in seven runs. Timer-started passes (the scheduler, the resume) were
 * never affected: a timer armed at load has no request to inherit.
 *
 * HOW. `AsyncResource.bind` captures the async context at bind time, and this module binds at LOAD —
 * it is imported statically by the component, so that context is the loader's, with no request and
 * no transaction. Calling `runDetached(fn)` from a handler runs `fn` in that context: each read then
 * takes its own implicit transaction. It returns whatever `fn` returns, so a handler can still await a
 * start function's quick acknowledgement; only the work `fn` sets running is detached.
 */
import { AsyncResource } from 'node:async_hooks';

export const runDetached = AsyncResource.bind((fn) => fn());
