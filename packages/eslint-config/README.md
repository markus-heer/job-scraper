# @job-scraper/eslint-config

The shared ESLint flat config. It is the config this package itself is linted with, so running
`pnpm --filter @job-scraper/eslint-config lint` checks the config against its own rules.

Two things it enforces:

- `simple-import-sort/imports` and `simple-import-sort/exports` keep import and export blocks ordered.
- `@typescript-eslint/no-explicit-any` makes `any` an error. Use `unknown` plus a Zod parse where a value genuinely
  arrives untyped (Playwright DOM evaluation results, raw AI_Provider JSON).

Usage in a package — create `eslint.config.mjs`:

```js
import baseConfig from '@job-scraper/eslint-config';

export default baseConfig;
```

To extend it, spread it and append package-specific blocks:

```js
import baseConfig from '@job-scraper/eslint-config';

export default [...baseConfig, { files: ['src/**/*.tsx'], rules: {} }];
```

Add both the config and `eslint` to the package's `devDependencies`, plus a `lint` script (`eslint .`) so
`turbo run lint` picks the package up.

## The React variant

`@job-scraper/eslint-config/react` is the base config plus what the browser half of the repository needs. `apps/web`
uses it:

```js
export { default } from '@job-scraper/eslint-config/react';
```

It adds three things:

- the `jsx-a11y` recommended rules, which carry the cheap half of Requirement 2.3 (WCAG 2.1 AA): a missing form label or
  a handler on a non-interactive element fails lint instead of surfacing in an `@axe-core/playwright` run much later;
- `react-hooks/rules-of-hooks` and `react-hooks/exhaustive-deps`, listed by name rather than pulled in through the
  plugin's own preset so that the enforced rule set is readable in `react.config.mjs`;
- browser globals. The Node globals of the base config stay in place, because `vite.config.ts` lives in the same package
  and really does run in Node.

`eslint-plugin-jsx-a11y@6.10.2` declares a peer range that stops at ESLint 9 while this repository runs ESLint 10. The
plugin loads and all 36 rules apply — verified with `eslint --print-config` — so the unmet peer warning from
`pnpm install` is expected. It disappears when the plugin widens its range.

Generated output is ignored by the shared config and must not be edited or linted: the Prisma client
(`**/generated/**`), `schema.gql`, the TanStack route tree (`**/*.gen.ts`) and the GraphQL Code Generator output
(`**/*.generated.ts`, `**/__generated__/**`). The list mirrors `.prettierignore`, so no generated file is formatted by
one tool and linted by the other.
