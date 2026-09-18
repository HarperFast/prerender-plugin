/**
 * The page under test: a deterministic, self-contained commerce-PDP-shaped document.
 *
 * WHY SYNTHETIC. The measurements this harness exists for are of OUR OWN in-page code — full-tree
 * element walks, scroll passes, shadow flattening, CSS pruning. Their cost is driven by the shape
 * of the DOM (element count, shadow-root count, rule count, page height), not by whose site it is.
 * A synthetic page fixes that shape, removes network jitter, and makes an A/B of a 3% change
 * legible. What it CANNOT tell you is whether a change is FAITHFUL on a real site — that needs a
 * real render (see README, "What this cannot answer").
 *
 * Shape is modelled on a production commerce PDP as measured in the deployment notes: ~18k light-DOM elements, a shadow-DOM
 * review widget that appears only after its anchor intersects (0 -> ~1,380 nodes), a reveal wrapper
 * with three class states, astro-island `props` attributes that dominate byte size, and a utility
 * stylesheet where most selectors never match.
 *
 * Deterministic: one seeded PRNG, no Date.now() in the markup, no randomness in the server. Two
 * runs produce byte-identical HTML, so a diff in a measurement is a diff in the code under test.
 */

import { createServer } from 'node:http';

/** mulberry32 — small, fast, deterministic. */
const rng = (seed) => () => {
	seed = (seed + 0x6d2b79f5) | 0;
	let t = seed;
	t = Math.imul(t ^ (t >>> 15), t | 1);
	t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// 1x1 transparent PNG — every <img> on the page resolves to this, so image bytes are constant and
// the only thing an image costs is the request + decode we are trying to measure.
const PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/gEBQ4kAAAAAAElFTkSuQmCC',
	'base64'
);

const SHAPE = {
	sections: 24, // lazy grid sections, injected on intersect
	tilesPerSection: 16,
	lazyTilesPerSection: 12,
	elementsPerTile: 18,
	shadowWidgets: 12,
	shadowRulesPerWidget: 140,
	shadowElementsPerWidget: 160,
	utilityRules: 3000, // most never match — what pruneUnmatchedCss is for
	reviewBlocks: 460, // x3 elements each = the ~1,380 matched review elements measured on a real PDP
	islands: 18, // astro-island elements carrying large props attributes
	islandPropsBytes: 24000,
};

const CLASSES = ['flex', 'grid', 'px-4', 'py-2', 'text-sm', 'font-bold', 'rounded', 'border', 'shadow-sm', 'mt-2'];

/** A utility stylesheet in the Tailwind idiom: thousands of rules, a handful of which match. */
function utilityCss(random) {
	let css =
		':root{--c:#111}body{margin:0;font:14px system-ui}.hdr{position:sticky;top:0;height:64px;background:#fff}\n';
	css += '.hdr.hide{transform:translateY(-100%)}\n';
	// Height is a measured property of the fixture, not an accident of the markup: a 4-column grid
	// of 64px cells puts the page at ~20,000px on a 390px viewport, which is PDP scale. A single
	// column of 280px cells (the obvious markup) is 270,000px and makes every scroll pass a
	// 300-step, 19-second crawl that no real page would charge.
	css += '.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:2px}\n';
	css += '.tile{display:block;height:64px;overflow:hidden;border:1px solid #eee;font-size:8px}\n';
	css += '.tile svg{width:6px;height:6px}\n';
	css += '#reviewList{display:grid;grid-template-columns:repeat(3,1fr);gap:2px}\n';
	css += '.rv-item{height:40px;overflow:hidden;font-size:8px}\n';
	css += '.transition-all{transition:all .7s}.max-h-0{max-height:0;opacity:0}.hidden{display:none}\n';
	for (let i = 0; i < SHAPE.utilityRules; i++) {
		const n = Math.floor(random() * 9999);
		// Deliberately a mix: pseudo-classes, attribute selectors with quotes, media groups, and a
		// small fraction that genuinely match — the same mix the prune pass has to judge.
		if (i % 17 === 0) css += `@media (min-width:${640 + (i % 5) * 160}px){.u-${n}:hover .u-${n}-x{gap:${i % 9}px}}\n`;
		else if (i % 11 === 0) css += `[data-u="${n}"]::after{content:"${n}"}\n`;
		else if (i % 7 === 0) css += `.u-${n}:not(.off) > .u-${n}-y{margin:${i % 5}px}\n`;
		else css += `.u-${n}{padding:${i % 13}px;color:var(--c)}\n`;
	}
	return css;
}

/** One product tile: the element-count workhorse, with lazy image attributes to resolve. */
function tile(i, random) {
	const cls = () => CLASSES[Math.floor(random() * CLASSES.length)];
	let html = `<div class="tile ${cls()}" data-tile="${i}">`;
	html += `<a href="/product/prd-${i}" class="${cls()}"><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" data-src="/asset/img/${i}.png" class="${cls()}" alt="Item ${i}"></a>`;
	html += `<div class="${cls()}"><span class="${cls()}">Brand ${i % 40}</span><h3 class="${cls()}">Product name ${i}</h3>`;
	html += `<div class="${cls()}"><span class="${cls()}">$${20 + (i % 80)}.99</span><s class="${cls()}">$${60 + (i % 90)}.00</s></div>`;
	// A star row inside plain light DOM plus one in a shadow widget elsewhere.
	html += `<div class="${cls()}" role="img" aria-label="${1 + (i % 5)} stars">`;
	for (let s = 0; s < 5; s++)
		html += `<svg viewBox="0 0 16 16" class="${cls()}"><path d="M8 0l2 5 5 .5-4 3 1 5-4-3-4 3 1-5-4-3 5-.5z"/></svg>`;
	html += '</div>';
	html += `<button class="${cls()}" data-u="${i}">Add</button></div></div>`;
	return html;
}

/** A custom element with an open shadow root and its own (unscoped) stylesheet. */
function shadowWidgetScript() {
	return `
class BenchWidget extends HTMLElement {
  connectedCallback() {
    if (this.shadowRoot) return;
    const sr = this.attachShadow({ mode: 'open' });
    const n = ${SHAPE.shadowElementsPerWidget};
    const rules = ${SHAPE.shadowRulesPerWidget};
    let css = ':host{display:block}button{background:#06c;color:#fff}svg{width:8px;height:8px}'
            + '.w-0{display:grid;grid-template-columns:repeat(8,1fr)}.w-0>div{height:12px;overflow:hidden;font-size:7px}';
    for (let i = 0; i < rules; i++) css += '.w-' + i + '{padding:' + (i % 7) + 'px}';
    css += '@media (min-width:600px){.w-0{gap:2px}}';
    let html = '<style>' + css + '</style><div class="w-0"><slot name="hdr"></slot>';
    for (let i = 0; i < n; i++) {
      html += '<div class="w-' + (i % rules) + '"><span>cell ' + i + '</span>'
           +  '<svg viewBox="0 0 16 16"><path d="M8 0l2 5 5 .5-4 3 1 5-4-3-4 3 1-5-4-3 5-.5z"/></svg></div>';
    }
    html += '</div>';
    sr.innerHTML = html;
  }
}
customElements.define('bench-widget', BenchWidget);`;
}

/**
 * The page's own behaviour: lazy sections that fill on intersect, a review widget that only starts
 * loading once its anchor intersects and then fills after a delay, a reveal wrapper that passes
 * through three class states, an onload-gated block, and perpetual cosmetic churn.
 */
function pageScript() {
	return `
const mkTiles = (host, from, count) => {
  let html = '';
  for (let i = from; i < from + count; i++) {
    html += '<div class="tile" data-tile="lz-' + i + '"><span>lazy ' + i + '</span>';
    for (let k = 0; k < 14; k++) html += '<span class="u-' + (i * k % 9999) + '">c' + k + '</span>';
    html += '</div>';
  }
  host.insertAdjacentHTML('beforeend', html);
};

// Lazy grid sections: fill on first intersection (what the scroll passes exist to trip).
const io = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    const host = e.target;
    io.unobserve(host);
    if (host.dataset.filled) continue;
    host.dataset.filled = '1';
    setTimeout(() => mkTiles(host, Number(host.dataset.idx) * 1000, ${SHAPE.lazyTilesPerSection}), 40);
  }
}, { rootMargin: '0px' });
for (const s of document.querySelectorAll('[data-lazy-section]')) io.observe(s);

// The review widget: nothing happens until #reviewsAnchor intersects. Then a fetch-shaped delay, then
// ~1,380 nodes land, then the reveal wrapper walks hidden -> max-h-0 -> revealed.
const reviewObserver = new IntersectionObserver((entries) => {
  if (!entries.some((e) => e.isIntersecting)) return;
  reviewObserver.disconnect();
  const list = document.getElementById('reviewList');
  const wrap = document.getElementById('reviewWrap');
  setTimeout(() => {
    let html = '';
    for (let i = 0; i < ${SHAPE.reviewBlocks}; i++) {
      html += '<div class="rv-item"><span class="rv-author">user' + i + '</span>'
           +  '<p class="rv-text">Review body number ' + i + ' with a sentence of text.</p></div>';
    }
    list.innerHTML = html;
    wrap.className = 'transition-all max-h-0';
    setTimeout(() => { wrap.className = 'transition-all opacity-100'; }, 120);
  }, Number(document.body.dataset.reviewDelay || 900));
}, { rootMargin: '0px' });
reviewObserver.observe(document.getElementById('reviewsAnchor'));

// A block that loads only after a SCROLL EVENT has fired — the fidelity tripwire for any variant
// that stops scrolling (a taller viewport, in particular). IntersectionObserver fires for content
// that is in view without ever being scrolled to; a scroll LISTENER does not, and plenty of real
// carousels and infinite lists hang off one. Without this marker, "the whole page in one viewport"
// looks free.
let scrollFired = false;
addEventListener(
  'scroll',
  () => {
    if (scrollFired) return;
    scrollFired = true;
    const host = document.getElementById('scrollGated');
    if (host) host.innerHTML = '<span id="scrollGatedOk">scroll-gated content</span>';
  },
  { passive: true, once: false }
);

// A block revealed only by an image's load event — the fidelity tripwire for turning images off.
const probe = document.getElementById('onloadProbe');
if (probe) {
  const img = new Image();
  img.onload = () => { probe.innerHTML = '<span id="onloadOk">image-gated content</span>'; };
  img.onerror = () => { probe.dataset.imgError = '1'; };
  img.src = '/asset/img/gate.png';
}

// Sticky header that hides on scroll-down and re-reveals at the top, on a throttled handler —
// the reason scroll.topSettleMs exists.
let lastY = 0, ticking = false;
addEventListener('scroll', () => {
  if (ticking) return;
  ticking = true;
  setTimeout(() => {
    const y = scrollY;
    document.querySelector('.hdr').classList.toggle('hide', y > lastY && y > 100);
    lastY = y;
    ticking = false;
  }, 30);
}, { passive: true });

// Cosmetic churn: text-only mutations forever. A DOM-stability check must NOT be reset by these.
let tick = 0;
setInterval(() => { document.getElementById('ticker').textContent = 'offer ends in ' + (tick++) + 's'; }, 100);
`;
}

function buildHtml(query) {
	const random = rng(1337);
	const reviewDelay = Number(query.get('reviewDelay') ?? 900);
	let html = '<!doctype html><html lang="en"><head><meta charset="utf-8">';
	html += '<title>Bench PDP — deterministic fixture</title>';
	html += '<link rel="canonical" href="http://127.0.0.1:PORT/product/prd-bench">';
	html += `<meta name="robots" content="${query.get('noindex') ? 'noindex' : 'index,follow'}">`;
	html += `<style>${utilityCss(random)}</style>`;
	html += '<link rel="stylesheet" href="/asset/css/app.css"><link rel="stylesheet" href="/asset/css/theme.css">';
	html += '<script type="application/ld+json">';
	html += JSON.stringify({
		'@context': 'https://schema.org',
		'@type': 'Product',
		'name': 'Bench Product',
		'offers': [
			{ '@type': 'Offer', 'price': '39.99', 'priceCurrency': 'USD', 'availability': 'https://schema.org/InStock' },
			{ '@type': 'Offer', 'price': '44.99', 'priceCurrency': 'USD', 'availability': 'https://schema.org/InStock' },
		],
	});
	html += '</script></head>';
	html += `<body data-review-delay="${reviewDelay}">`;
	html += '<header class="hdr"><nav><span id="ticker">offer ends in 0s</span></nav></header>';

	// Above-the-fold product block.
	html += '<main><section class="pdp"><h1>Bench Product</h1>';
	html += '<div id="onloadProbe"></div><div id="scrollGated"></div>';
	for (let i = 0; i < SHAPE.islands; i++) {
		// astro-island-shaped: a huge props attribute, the byte-dominant thing removeAttributes strips.
		const props = JSON.stringify({ blob: 'x'.repeat(SHAPE.islandPropsBytes / 2), i });
		html += `<astro-island uid="i${i}" component-url="/asset/js/island.js" props='${props.replace(/'/g, '&#39;')}' ssr><div class="isl">island ${i}</div></astro-island>`;
	}
	html += '</section>';

	// The element-count body: static tiles + lazy sections + shadow widgets interleaved.
	for (let s = 0; s < SHAPE.sections; s++) {
		html += `<section data-lazy-section data-idx="${s}" class="grid">`;
		for (let t = 0; t < SHAPE.tilesPerSection; t++) html += tile(s * 100 + t, random);
		html += '</section>';
		if (s % Math.ceil(SHAPE.sections / SHAPE.shadowWidgets) === 0) {
			html += `<bench-widget><h2 slot="hdr">Widget ${s}</h2><p>light child</p></bench-widget>`;
		}
	}

	// The review block, at the bottom — below the fold on a short viewport, in view on a tall one.
	html += '<section id="reviewsAnchor"><h2>Customer Reviews</h2>';
	html +=
		'<div id="reviewTabs"><div id="reviewWrap" class="transition-all hidden"><div id="reviewList"></div></div></div>';
	html += '</section></main>';

	// `?chunks=N` raises the SUB-RESOURCE count without touching the DOM, the CSS or the page height,
	// so every other number in this bench stays comparable. It exists for the resource-cache and
	// UV_THREADPOOL_SIZE questions: a production storefront page makes ~70 cacheable sub-resource
	// requests per render and the default fixture makes 11, so a null result at 11 bounds the lever
	// rather than settling it. Each extra chunk is a real ~110KB bundle, fetched, cached and compiled.
	const chunks = Math.max(1, Number(query.get('chunks') ?? 8));
	for (let i = 0; i < chunks; i++) html += `<script src="/asset/js/chunk-${i}.js"></script>`;
	html += '<script src="/asset/js/vendor.js"></script>';
	html += '<script src="/asset/js/analytics-beacon.js"></script>'; // matches the blocked pattern
	html += `<script>${shadowWidgetScript()}</script>`;
	html += `<script>${pageScript()}</script>`;
	html += '</body></html>';
	return html;
}

/**
 * A script bundle that is actually parsed, compiled and executed — the thing a commerce page's
 * cost is really made of, and the thing the first version of this fixture did not have at all.
 *
 * Deterministic and cached by path so two runs compile byte-identical source. Each bundle defines a
 * few hundred functions and runs a little work at module scope, so V8 has something to compile and
 * something to keep in a code cache.
 */
const bundleCache = new Map();
function bundle(pathname) {
	const cached = bundleCache.get(pathname);
	if (cached) return cached;
	const random = rng(pathname.length * 7919);
	const fns = Math.round(400 + random() * 200);
	let src = `(() => {\n  const registry = {};\n`;
	for (let i = 0; i < fns; i++) {
		src += `  registry.f${i} = function f${i}(a, b) {\n`;
		src += `    const k = (a || ${i}) * ${1 + (i % 13)} + (b || 0);\n`;
		src += `    const s = String(k).split('').reverse().join('');\n`;
		src += `    return { k, s, tag: 'f${i}', n: s.length + ${i % 7} };\n  };\n`;
	}
	src += `  let acc = 0;\n  for (const key of Object.keys(registry)) acc += registry[key](acc, 1).n;\n`;
	src += `  window.__bundle = (window.__bundle || 0) + acc;\n})();\n`;
	bundleCache.set(pathname, src);
	return src;
}

/** Start the fixture server. Returns { url, close, requests } — requests is a live per-path count. */
export async function startFixture({ port = 0 } = {}) {
	const requests = new Map();
	const count = (path) => requests.set(path, (requests.get(path) ?? 0) + 1);

	const server = createServer((req, res) => {
		const url = new URL(req.url, 'http://127.0.0.1');
		// The counters, readable over HTTP so a runner in ANOTHER process can still report requests per
		// render. Not counted itself, and never served to the page.
		if (url.pathname === '/__stats') {
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify(Object.fromEntries(requests)));
			return;
		}
		count(url.pathname.replace(/\/\d+\.png$/, '/N.png'));

		if (url.pathname === '/product/prd-bench' || url.pathname === '/') {
			const body = buildHtml(url.searchParams).replaceAll('PORT', String(server.address().port));
			// `?cookies=N` hands the render N cookies. It exists to price `resetForNextVariant`, which
			// deletes the jar one `Network.deleteCookies` call at a time — so the wipe's cost is a
			// function of jar SIZE, and a fixture that sets no cookies prices it at zero. A real
			// storefront handed over 125 (see variantContext.ts), which is the number to test at.
			const jar = Math.max(0, Math.min(500, Number(url.searchParams.get('cookies') ?? 0)));
			const setCookie = [];
			for (let i = 0; i < jar; i++) setCookie.push(`bench_c${i}=v${i}; Path=/; SameSite=Lax`);
			res.writeHead(200, {
				'content-type': 'text/html; charset=utf-8',
				'cache-control': 'public, max-age=60',
				...(setCookie.length ? { 'set-cookie': setCookie } : {}),
			});
			res.end(body);
			return;
		}
		if (url.pathname.endsWith('.png')) {
			res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=3600' });
			res.end(PNG);
			return;
		}
		if (url.pathname.endsWith('.css')) {
			res.writeHead(200, { 'content-type': 'text/css', 'cache-control': 'public, max-age=3600' });
			res.end('.app-1{color:#111}.app-2:hover{color:#222}');
			return;
		}
		if (url.pathname.endsWith('.js')) {
			res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'public, max-age=3600' });
			res.end(bundle(url.pathname));
			return;
		}
		res.writeHead(404, { 'content-type': 'text/plain' });
		res.end('not found');
	});

	await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
	const { port: actual } = server.address();
	return {
		url: `http://127.0.0.1:${actual}/product/prd-bench`,
		requests,
		close: () => new Promise((resolve) => server.close(resolve)),
	};
}

export { SHAPE };
