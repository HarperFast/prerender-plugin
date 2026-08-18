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
	querySelector() {
		return null;
	}
	focus() {}
}

/** Install the shim. Idempotent, so every test file can call it. */
export function installDom() {
	globalThis.document = {
		createElement: (tag) => new ShimNode(tag),
		createElementNS: (_ns, tag) => new ShimNode(tag),
		createTextNode: (text) => {
			const node = new ShimNode('#text');
			node.textContent = text;
			return node;
		},
		getElementById: () => new ShimNode('div'),
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
