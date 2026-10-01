/**
 * Run work a request starts but must not share its transaction with — here, the read cache's writes —
 * in this module's own async context.
 *
 * Harper carries a request's transaction in the async context, so a write a handler starts and does
 * not finish inside it joins that transaction, which Harper closes after the response: the write is
 * then aborted ("Database closed during transaction"). The plugin measured exactly this on detached
 * reads (packages/plugin/src/util/detach.js has the numbers). `AsyncResource.bind` captures the
 * context at bind time, and this module binds at LOAD — it must be imported statically, never first
 * from inside a request — so `fn` runs with no request and takes its own implicit transaction. It
 * returns whatever `fn` returns, so a caller can still await it.
 */
import { AsyncResource } from 'node:async_hooks';

// A synchronous throw comes back as a rejected promise, so the caller's `.catch` sees it too.
export const runDetached = AsyncResource.bind((fn) => {
	try {
		return fn();
	} catch (e) {
		return Promise.reject(e);
	}
});
