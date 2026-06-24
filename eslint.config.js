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
];
