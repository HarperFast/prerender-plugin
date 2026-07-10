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
const isBotRequest = (request) => {
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
