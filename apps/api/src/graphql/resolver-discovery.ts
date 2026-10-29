/**
 * Finding every GraphQL resolver class of the API_Service without starting the application.
 *
 * `GraphQLModule.forRoot({ autoSchemaFile })` writes `src/schema.gql` from the resolvers Nest has
 * instantiated, which means the running application is normally the only thing that can refresh
 * the schema — and starting it needs a validated environment file and a reachable Posting_Store.
 * The Web_App's code generator reads that file, so the schema would be refreshed only by whoever
 * happens to boot the API_Service, and a resolver added without a boot in between would silently
 * be missing from the generated hooks.
 *
 * This module removes the boot from that path. Nest keeps a module's `imports` and `providers` in
 * decorator metadata, and `@Resolver()` leaves `RESOLVER_TYPE_METADATA` on the class it decorates.
 * Both are readable from the class objects alone: no provider is constructed, no lifecycle hook
 * runs, nothing connects anywhere. Walking the module graph of `AppModule` therefore yields the
 * same resolver set the running application registers, which is what makes the offline schema
 * emission of `./schema-file.ts` equal to the file the API_Service writes at startup.
 *
 * Deriving the set from the module graph rather than from a hand-written list is deliberate: a list
 * is a second place to remember, and the failure mode of forgetting it — a resolver missing from
 * `schema.gql` and from the generated hooks — is exactly the one this file exists to prevent.
 */

import { ENTRY_PROVIDER_WATERMARK, MODULE_METADATA } from '@nestjs/common/constants';
import { RESOLVER_TYPE_METADATA } from '@nestjs/graphql';

/**
 * A class reference as it appears in module metadata. Resolver classes are never instantiated
 * here, so `abstract new` is the widest form that still excludes plain functions and objects.
 */
export type ResolverClass = abstract new (...args: never[]) => unknown;

/** Anything that can appear in a module's `imports` array. */
type ModuleEntry =
  | ResolverClass
  | { readonly module?: unknown; readonly imports?: unknown; readonly providers?: unknown }
  | { readonly forwardRef: () => unknown };

function isClassLike(candidate: unknown): candidate is ResolverClass {
  return typeof candidate === 'function';
}

function isRecord(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === 'object' && candidate !== null;
}

/**
 * True for a class that carries `@Resolver()` metadata.
 *
 * Two keys, because one of them is only set for part of the decorator's forms:
 * `RESOLVER_TYPE_METADATA` holds the name of the object type a `@Resolver(() => Model)` resolves
 * fields of and stays undefined for a plain `@Resolver()`, which is what the four root-field-only
 * resolvers of this API use. `ENTRY_PROVIDER_WATERMARK` is set by every form of the decorator and
 * by nothing else in the Nest packages, so it is the reliable half; the first key is kept so that
 * a resolver remains recognised if the watermark is ever dropped again.
 */
export function isResolverClass(candidate: unknown): candidate is ResolverClass {
  if (!isClassLike(candidate)) {
    return false;
  }

  return (
    Reflect.getMetadata(ENTRY_PROVIDER_WATERMARK, candidate) === true ||
    Reflect.getMetadata(RESOLVER_TYPE_METADATA, candidate) != null
  );
}

/**
 * The classes a `providers` entry contributes. A provider is either the class itself or a provider
 * object; of the four provider forms only `useClass` can carry resolver metadata, because
 * `useValue` and `useFactory` produce instances and `useExisting` is an alias of another provider
 * that is itself listed somewhere.
 */
function providerClasses(provider: unknown): readonly unknown[] {
  if (isClassLike(provider)) {
    return [provider];
  }

  if (isRecord(provider) && 'useClass' in provider) {
    return [provider.useClass];
  }

  return [];
}

function toArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Collects every `@Resolver()`-decorated class reachable from a root module.
 *
 * The walk handles the three shapes a Nest `imports` entry has: a module class, a dynamic module
 * (`GraphQLModule.forRoot(...)` and the like, which carry their own `imports` and `providers` next
 * to the `module` class) and a `forwardRef` wrapper. Visited modules are tracked, so a cycle
 * between two modules terminates instead of recursing forever.
 *
 * The result is sorted by class name, which is what makes the emitted schema byte-stable: without
 * it the field order inside `type Query` would follow the module traversal order and could change
 * when an unrelated module is added.
 */
export function discoverResolverClasses(rootModule: ResolverClass): readonly ResolverClass[] {
  const visitedModules = new Set<unknown>();
  const resolvers = new Set<ResolverClass>();
  const pending: unknown[] = [rootModule];

  while (pending.length > 0) {
    const entry = pending.pop() as ModuleEntry | undefined;

    if (entry == null) {
      continue;
    }

    if (isRecord(entry) && 'forwardRef' in entry && typeof entry.forwardRef === 'function') {
      pending.push(entry.forwardRef());
      continue;
    }

    // A dynamic module brings its own imports and providers; its `module` class is visited as well,
    // because the statically declared metadata on that class applies too.
    if (isRecord(entry) && 'module' in entry) {
      pending.push(entry.module, ...toArray(entry.imports));

      for (const provider of toArray(entry.providers)) {
        pending.push(...providerClasses(provider));
      }

      continue;
    }

    if (!isClassLike(entry) || visitedModules.has(entry)) {
      continue;
    }

    visitedModules.add(entry);

    if (isResolverClass(entry)) {
      resolvers.add(entry);
    }

    pending.push(...toArray(Reflect.getMetadata(MODULE_METADATA.IMPORTS, entry)));

    for (const provider of toArray(Reflect.getMetadata(MODULE_METADATA.PROVIDERS, entry))) {
      pending.push(...providerClasses(provider));
    }
  }

  return [...resolvers].sort((left, right) => left.name.localeCompare(right.name, 'en'));
}
