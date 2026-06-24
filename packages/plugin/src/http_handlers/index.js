import { config } from '../config.js';
import { handleBotRequest } from './bot_request.js';
import { isForwardedMode, resolveForwardedRequest } from '../util/ingress.js';

// Read configuration lazily so host overrides (and live reload) apply.
//
// In 'prefix' mode a bot request is any path under botPathPrefix. In 'forwarded'
// mode it is any request whose device-stripped path matches a configured route;
// the resolved target is stashed on the request so handleBotRequest doesn't repeat
// the work. Non-matching requests fall through to Harper's REST routing (which
// serves the plugin's own resource endpoints).
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
