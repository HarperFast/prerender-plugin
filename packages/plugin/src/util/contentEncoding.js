import zlib from 'node:zlib';

const contentEncodingPriority = ['br', 'gzip'];

export const getAcceptedEncodings = (header) => {
	if (!header) {
		return [];
	}

	return header.split(',').map((e) => {
		const end = e.indexOf(';');

		if (end !== -1) {
			e = e.substring(0, end);
		}

		return e.trim();
	});
};

export function getBestEncoding(acceptedEncodings, contentEncoding) {
	if (acceptedEncodings.includes(contentEncoding)) {
		return contentEncoding;
	}

	for (const priority of contentEncodingPriority) {
		if (acceptedEncodings.includes(priority)) {
			return priority;
		}
	}

	return null;
}

export function reencode(src, srcEncoding, destEncoding, forStatic = false) {
	let dest = src;

	if (srcEncoding !== destEncoding) {
		if (srcEncoding) {
			dest = decode(src, srcEncoding);
		}
		if (destEncoding) {
			dest = encode(dest, destEncoding, forStatic);
		}
	}

	return dest;
}

export function encode(uncompressed, encoding, forStatic = false) {
	if (!encoding) {
		return uncompressed;
	}

	if (encoding === 'gzip') {
		return Buffer.isBuffer(uncompressed)
			? zlib.gzipSync(uncompressed)
			: uncompressed.pipe(
					zlib.createGzip({
						level: forStatic ? zlib.constants.Z_BEST_COMPRESSION : zlib.constants.Z_DEFAULT_COMPRESSION,
					})
				);
	} else if (encoding === 'br') {
		return Buffer.isBuffer(uncompressed)
			? zlib.brotliCompressSync(uncompressed)
			: uncompressed.pipe(
					zlib.createBrotliCompress({
						params: {
							[zlib.constants.BROTLI_PARAM_QUALITY]: forStatic ? 10 : 2,
							[zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
						},
					})
				);
	} else {
		throw new Error('Unsupported content encoding: ' + encoding);
	}
}

export function decode(data, encoding) {
	if (!encoding) {
		return data;
	}
	switch (encoding) {
		case 'br':
			return Buffer.isBuffer(data) ? zlib.brotliDecompressSync(data) : data.pipe(zlib.createBrotliDecompress());
		case 'gzip':
			return Buffer.isBuffer(data) ? zlib.gunzipSync(data) : data.pipe(zlib.createGunzip());
		default:
			throw new Error('Unsupported content encoding: ' + encoding);
	}
}
