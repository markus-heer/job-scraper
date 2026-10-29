import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

import { baseConfig } from './eslint.config.mjs';

/**
 * Shared flat config for the React Web_App, layered on top of `baseConfig`.
 *
 * Three additions over the base config, each one covering a mistake class that is specific to the
 * browser half of the repository:
 *
 * - `jsx-a11y` recommended rules. Requirement 2.3 asks for WCAG 2.1 AA, and a missing form label or
 *   a click handler on a non-interactive element is exactly the kind of regression that a lint rule
 *   catches earlier and cheaper than the `@axe-core/playwright` checks of the E2E layer.
 * - the two `react-hooks` rules. They are added by name rather than through the plugin's own config
 *   preset so that the rule set this repository enforces is readable in this file.
 * - browser globals. The Node globals from `baseConfig` stay in place on purpose: `vite.config.ts`
 *   and `vitest.config.ts` live in the same package and really do run in Node.
 */
export const reactConfig = tseslint.config(...baseConfig, {
  files: ['**/*.{ts,tsx}'],
  plugins: { 'jsx-a11y': jsxA11y, 'react-hooks': reactHooks },
  languageOptions: {
    globals: { ...globals.browser },
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
  rules: {
    ...jsxA11y.flatConfigs.recommended.rules,
    'react-hooks/rules-of-hooks': 'error',
    'react-hooks/exhaustive-deps': 'error',
  },
});

export default reactConfig;
