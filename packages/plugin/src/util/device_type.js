import { config } from '../config.js';

/**
 * Normalizes a device-type string to one of the configured supported types,
 * falling back to the first supported type for unknown values.
 */
export const sanitizeDeviceType = (deviceType) => {
	const supported = config.deviceTypes.supported;
	const lc = deviceType?.toLowerCase();

	const idx = supported.indexOf(lc);

	return idx === -1 ? supported[0] : supported[idx];
};

/**
 * Forwarded path-based device detection. When the first path segment is a
 * supported device type it is consumed: returns that device type and the path
 * with the segment removed. Otherwise the request carries no device prefix — the
 * upstream proxy only prefixes bot/prerender traffic — so it isn't a prerender
 * request: returns `{ deviceType: null, path }` with the path unchanged, and the
 * caller skips it.
 *
 *   '/mobile/product/prd-1'  -> { deviceType: 'mobile', path: '/product/prd-1' }
 *   '/tablet'                -> { deviceType: 'tablet', path: '/' }
 *   '/catalog/x'             -> { deviceType: null,     path: '/catalog/x' }
 *   '/'                      -> { deviceType: null,     path: '/' }
 */
export const extractDeviceFromPath = (pathname) => {
	const supported = config.deviceTypes.supported;
	const slashIndex = pathname.indexOf('/', 1);
	const firstSegment = (slashIndex === -1 ? pathname.slice(1) : pathname.slice(1, slashIndex)).toLowerCase();

	if (firstSegment && supported.includes(firstSegment)) {
		return { deviceType: firstSegment, path: slashIndex === -1 ? '/' : pathname.slice(slashIndex) };
	}

	return { deviceType: null, path: pathname };
};
