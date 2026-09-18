/**
 * The fixture, in its OWN process.
 *
 * `startFixture()` runs an HTTP server on the caller's event loop. That is fine for a single render
 * and actively misleading under load: at concurrency 24 one Node thread was serving ~9,600 HTTP
 * responses (including ~113KB script bundles) WHILE handling CDP traffic and every
 * request-interception callback for 24 renders. A concurrency ladder measured that way finds the
 * harness's event loop, not the renderer's ceiling — and production does not have that shape at all,
 * because the origin is a different machine.
 *
 *   node bench/render-cpu/fixture-server.js --port 58200
 */
import { startFixture } from './fixture.js';

const args = process.argv.slice(2);
const i = args.indexOf('--port');
const port = i >= 0 ? Number(args[i + 1]) : 58200;
const fixture = await startFixture({ port });
console.log(fixture.url);
process.on('SIGTERM', () => fixture.close().then(() => process.exit(0)));
