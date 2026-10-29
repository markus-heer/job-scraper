/**
 * Locating and loading the local environment file (1.12).
 *
 * The file lives next to `pnpm-workspace.yaml` at the repository root, not inside `apps/api`:
 * the Start_Script, the API_Service and the Web_App read the same keys, and three copies of one
 * file would drift. The root is found by walking up from this module rather than from
 * `process.cwd()`, because the API_Service is started from the repository root by the Start_Script
 * and from `apps/api` by a developer, and both have to find the same file. `__dirname` sits two
 * levels below `apps/api` in `src/config` and in the compiled `dist/config` alike, so the walk is
 * the same distance in both.
 *
 * Reading the file is Node's own `process.loadEnvFile`, which is why the Job_Tool needs no
 * `dotenv` dependency. Its precedence is worth knowing: a variable already present in
 * `process.env` wins over the file. That is the behaviour the Job_Tool wants — a developer who
 * exports `API_PORT` for one run should not have to edit the shared file.
 *
 * Requirements: 1.12.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Name of the environment file, as excluded in `.gitignore`. */
export const ENV_FILE_NAME = '.env';

/** The file that marks the repository root; `package.json` would also match every workspace. */
const WORKSPACE_MARKER = 'pnpm-workspace.yaml';

/** Walks up from `startDir` to the directory holding the workspace marker. */
export const findWorkspaceRoot = (startDir: string): string | null => {
  let current = startDir;

  for (;;) {
    if (existsSync(join(current, WORKSPACE_MARKER))) {
      return current;
    }

    const parent = dirname(current);

    if (parent === current) {
      return null;
    }

    current = parent;
  }
};

/** Absolute path of the environment file, falling back to the working directory. */
export const resolveEnvFilePath = (startDir: string = __dirname): string =>
  join(findWorkspaceRoot(startDir) ?? process.cwd(), ENV_FILE_NAME);

/** Where the environment file was looked for and whether it could be read. */
export interface EnvFileLoadResult {
  readonly path: string;
  readonly loaded: boolean;
}

/**
 * Loads the environment file into `process.env`.
 *
 * An absent or unreadable file is not an error on its own. The configuration check that follows
 * names every key that is now missing (1.15), which is a more useful message than "file not
 * found" for the case where the keys come from the shell instead.
 */
export const loadEnvFile = (path: string = resolveEnvFilePath()): EnvFileLoadResult => {
  if (!existsSync(path)) {
    return { path, loaded: false };
  }

  try {
    process.loadEnvFile(path);

    return { path, loaded: true };
  } catch {
    return { path, loaded: false };
  }
};
