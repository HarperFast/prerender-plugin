import zlib from 'zlib';
import { promisify } from 'util';

const pGzip = promisify(zlib.gzip);
const pBrotliCompress = promisify(zlib.brotliCompress);

export function encode(content: string, encoding: string) {
	if (encoding === 'gzip') {
		return pGzip(content, { level: zlib.constants.Z_DEFAULT_LEVEL });
	} else if (encoding === 'br') {
		return pBrotliCompress(content, {
			params: {
				[zlib.constants.BROTLI_PARAM_QUALITY]: 10,
				[zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
			},
		});
	} else {
		throw new Error('Unsupported content encoding: ' + encoding);
	}
}
