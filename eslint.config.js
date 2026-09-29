import harperConfig from '@harperdb/code-guidelines/eslint';

export default [
	{
		// The render browser is a TypeScript service type-checked by its own
		// toolchain (tsc); it is not linted against the plugin's JS rules.
		ignores: ['**/node_modules/**', '**/dist/**', 'packages/browser/**'],
	},
	...harperConfig,
	// Your custom configuration here
	{
		rules: {
			// Rest-destructuring to OMIT keys (`const { medians, ...rest } = row`) is the idiom the
			// console tests use to build downgraded fixtures — the unused bindings are the point.
			'no-unused-vars': ['error', { ignoreRestSiblings: true }],
		},
	},
	{
		// The plugin is linted for undeclared identifiers too, with Harper's injected globals declared.
		//
		// The shared config switches `no-undef` off because Harper code references globals no config
		// declares. That also hid a real bug: v0.94.0 deleted a local that `POST
		// /prerender_admin/revalidate` still returned, so the handler threw a ReferenceError after
		// filing the render, and Harper's transaction wrapper rolled the render back. Lint passed and
		// no test called the handler. The Harper list below is exactly the set Harper declares global
		// in its own `dist/index.d.ts`, so a new Harper global belongs here only once Harper declares
		// it. The Node list is what the plugin uses; add to it when new code needs another runtime
		// global.
		files: ['packages/plugin/**/*.js'],
		languageOptions: {
			globals: {
				// Harper
				contentTypes: 'readonly',
				createBlob: 'readonly',
				databases: 'readonly',
				logger: 'readonly',
				operation: 'readonly',
				Resource: 'readonly',
				server: 'readonly',
				tables: 'readonly',
				threads: 'readonly',
				transaction: 'readonly',
				// Node
				AbortController: 'readonly',
				AbortSignal: 'readonly',
				Blob: 'readonly',
				Buffer: 'readonly',
				clearImmediate: 'readonly',
				clearInterval: 'readonly',
				clearTimeout: 'readonly',
				console: 'readonly',
				fetch: 'readonly',
				Headers: 'readonly',
				performance: 'readonly',
				process: 'readonly',
				queueMicrotask: 'readonly',
				ReadableStream: 'readonly',
				Request: 'readonly',
				Response: 'readonly',
				setImmediate: 'readonly',
				setInterval: 'readonly',
				setTimeout: 'readonly',
				structuredClone: 'readonly',
				TextDecoder: 'readonly',
				TextEncoder: 'readonly',
				URL: 'readonly',
				URLSearchParams: 'readonly',
			},
		},
		rules: {
			'no-undef': 'error',
		},
	},
	{
		// The console's browser client is linted for undeclared identifiers as well.
		//
		// The browser client has no excuse for an undeclared identifier: everything it uses is either a
		// standard browser global or an import. Without this rule a MISSING IMPORT is invisible to lint
		// and fatal at runtime, and nothing else catches it — these modules have no build step and no
		// type checker, and the test suite covers the pure helpers rather than the views. That is not
		// hypothetical: moving a panel between two views passed lint and prettier with a missing
		// `duration` import, and only failed when the view was actually executed.
		files: ['packages/console/src/admin/**/*.js'],
		languageOptions: {
			globals: {
				console: 'readonly',
				document: 'readonly',
				fetch: 'readonly',
				localStorage: 'readonly',
				location: 'readonly',
				navigator: 'readonly',
				setTimeout: 'readonly',
				clearTimeout: 'readonly',
				setInterval: 'readonly',
				clearInterval: 'readonly',
				URL: 'readonly',
				URLSearchParams: 'readonly',
				window: 'readonly',
			},
		},
		rules: {
			'no-undef': 'error',
		},
	},
];
