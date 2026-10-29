# @job-scraper/typescript-config

Shared strict TypeScript configurations. `base.json` holds the strictness settings; every workspace package extends one
of the three variants instead of repeating compiler options.

| Variant        | Used by                                | Notes                                                        |
| -------------- | -------------------------------------- | ------------------------------------------------------------ |
| `library.json` | `packages/domain`, `packages/scrapers` | ESM (`NodeNext`), emits declarations.                        |
| `nest.json`    | `apps/api`                             | CommonJS plus decorator metadata for NestJS and GraphQL.     |
| `react.json`   | `apps/web`                             | DOM libs, `react-jsx`, `noEmit` because Vite does the build. |

Usage in a package:

```json
{
  "extends": "@job-scraper/typescript-config/library.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*.ts", "__tests__/**/*.ts"]
}
```

`outDir`, `rootDir`, `include` and `exclude` belong in the consuming package: relative paths inside an extended config
resolve against the file that declares them, not against the consumer.

Two constraints worth knowing before adding a package:

- `library.json` sets `verbatimModuleSyntax` together with `NodeNext`. A package using it must declare
  `"type": "module"` in its `package.json`, otherwise TypeScript reads the files as CommonJS and rejects every `export`
  (TS1287).
- `nest.json` turns `strictPropertyInitialization` off. Nothing else relaxes `strict`.

`noImplicitAny` here and `@typescript-eslint/no-explicit-any` in `@job-scraper/eslint-config` are the two halves of the
same ban: the compiler catches inferred `any`, the linter catches written `any`. `exactOptionalPropertyTypes` is
deliberately not enabled — it conflicts with the optional-property shapes of Prisma, Apollo and Playwright.
