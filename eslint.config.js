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
			// Override or add custom rules
		},
	},
	{
		// The console's browser client, and ONLY it, is linted for undeclared identifiers.
		//
		// `no-undef` is switched off by the shared config, which is right for the server packages —
		// they run inside Harper and reference its injected globals (`databases`, `server`, `logger`,
		// `tables`) that no config declares. The browser client has no such excuse: everything it uses
		// is either a standard browser global or an import. Without this rule a MISSING IMPORT is
		// invisible to lint and fatal at runtime, and nothing else catches it — these modules have no
		// build step and no type checker, and the test suite covers the pure helpers rather than the
		// views. That is not hypothetical: moving a panel between two views passed lint and prettier
		// with a missing `duration` import, and only failed when the view was actually executed.
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
