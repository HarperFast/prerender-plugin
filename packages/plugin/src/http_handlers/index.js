import { config } from '../config.js';
import { handleBotRequest } from './bot_request.js';
import { isForwardedMode, resolveForwardedRequest } from '../util/ingress.js';

// Read configuration lazily so host overrides (and live reload) apply.
//
// In 'prefix' mode a bot request is any path under botPathPrefix. In 'forwarded'
// mode resolveForwardedRequest decides: a device-prefixed request (path mode) is bot
// traffic even if it matches no configured route, whereas an unprefixed request — or a
// header-mode request that matches no route — falls through to Harper's REST routing
// (which serves the plugin's own resource endpoints). The resolved target is stashed
// on the request so handleBotRequest doesn't repeat the work.
// The management UI's REST mount. Bot routing must never swallow it: in forwarded mode a
// device-prefixed path is treated as bot traffic even when it matches no route, and a broad
// `prefix` route (e.g. '/') matches everything — either would shadow the admin endpoint and
// leave it unreachable in exactly the deployments where it is most needed.
const ADMIN_PATH = '/prerender_admin';

const isAdminRequest = (request) => {
	const path = request.url.split('?')[0];
	return path === ADMIN_PATH || path.startsWith(`${ADMIN_PATH}/`);
};

const isBotRequest = (request) => {
	if (isAdminRequest(request)) return false;

	if (isForwardedMode()) {
		const target = resolveForwardedRequest(request);
		if (!target) return false;
		request._prerenderTarget = target;
		return true;
	}
	return request.url.startsWith(config.botPathPrefix);
};

server.http((request, nextHandler) => {
	if (isBotRequest(request)) return handleBotRequest(request);

	return nextHandler(request);
});
