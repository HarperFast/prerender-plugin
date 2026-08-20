/**
 * The smallest DOM the console's presentational helpers need, so they can be tested in node.
 *
 * The rest of this suite tests pure functions, which is why none of this existed. It exists now
 * because a whole class of defect in this client is invisible without executing the DOM code: the
 * modules have no build step and no type checker, and a control that recurses while building itself
 * parses, lints and formats perfectly. One did — `durationInput` emitted its value during
 * construction, which staged it, which re-rendered, which rebuilt the control. Nothing but running
 * it finds that.
 *
 * Deliberately not jsdom: this is a handful of methods, it adds no dependency, and a shim that only
 * implements what `el()` uses cannot drift into testing the shim instead of the code.
 */

class ShimNode {
	constructor(tag) {
		this.tagName = String(tag).toUpperCase();
		this.children = [];
		this.attributes = {};
		this.style = {};
		this.listeners = {};
		this.ownText = '';
		// The shell restores this across a rebuild; a plain field is all that behaviour needs.
		this.scrollTop = 0;
	}

	get textContent() {
		return this.ownText || this.children.map((child) => child.textContent ?? '').join('');
	}
	set textContent(value) {
		this.ownText = String(value);
		this.children = [];
	}

	set className(value) {
		this.attributes.class = value;
	}
	get className() {
		return this.attributes.class ?? '';
	}

	setAttribute(name, value) {
		this.attributes[name] = String(value);
	}
	getAttribute(name) {
		return this.attributes[name];
	}
	removeAttribute(name) {
		delete this.attributes[name];
	}

	appendChild(child) {
		this.children.push(child);
		return child;
	}

	addEventListener(type, handler) {
		(this.listeners[type] ??= []).push(handler);
	}

	/** Fire every handler for `type`, as a real event would. */
	fire(type, event = {}) {
		for (const handler of this.listeners[type] ?? []) handler({ target: this, ...event });
	}

	set value(v) {
		this.attributes.value = v;
	}
	get value() {
		return this.attributes.value ?? '';
	}
	set disabled(v) {
		this.attributes.disabled = v;
	}
	set checked(v) {
		this.attributes.checked = v;
	}

	get classList() {
		return { add: () => {}, remove: () => {}, toggle: () => {} };
	}

	/**
	 * Depth-first, first match, and ONLY the `.class` form — the single selector shape this client
	 * uses. A stub returning null was fine while nothing depended on the answer; the shell now finds
	 * its scroll container this way, and a stub would have made that code untestable while looking
	 * like it passed.
	 */
	querySelector(selector) {
		if (typeof selector !== 'string' || !selector.startsWith('.')) return null;
		const wanted = selector.slice(1);
		for (const child of this.children) {
			if (
				String(child.attributes?.class ?? '')
					.split(/\s+/)
					.includes(wanted)
			)
				return child;
			const hit = child.querySelector?.(selector);
			if (hit) return hit;
		}
		return null;
	}

	focus() {}
}

/** Install the shim. Idempotent, so every test file can call it. */
export function installDom() {
	const roots = new Map();
	globalThis.document = {
		createElement: (tag) => new ShimNode(tag),
		createElementNS: (_ns, tag) => new ShimNode(tag),
		createTextNode: (text) => {
			const node = new ShimNode('#text');
			node.textContent = text;
			return node;
		},
		// MEMOIZED, because a browser's #app persists across renders and the console's whole render
		// model is "replace the children of that one node". Handing out a fresh node per call made
		// every render start from a tree nobody could observe — including the previous one, which
		// is where the shell reads the scroll position it is about to restore.
		getElementById: (id) => {
			let node = roots.get(id);
			if (!node) roots.set(id, (node = new ShimNode('div')));
			return node;
		},
	};
	globalThis.location ??= { pathname: '/prerender_console' };
	globalThis.localStorage ??= { getItem: () => null, setItem: () => {} };
}

/** Depth-first search of a built tree. */
export function find(node, predicate) {
	if (!node || typeof node !== 'object') return null;
	for (const child of [node].flat(6)) {
		if (!child || typeof child !== 'object') continue;
		if (predicate(child)) return child;
		const hit = find(child.children ?? [], predicate);
		if (hit) return hit;
	}
	return null;
}

export const byTag = (node, tag) => find(node, (n) => n.tagName === String(tag).toUpperCase());
