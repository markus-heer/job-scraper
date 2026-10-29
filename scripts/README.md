# @job-scraper/scripts

The entry points a developer or the user runs directly, and the decision logic behind them.

| File                   | Entry point              | Purpose                                                     |
| ---------------------- | ------------------------ | ----------------------------------------------------------- |
| `start.mjs`            | `pnpm start [--offline]` | The Start_Script of Requirement 1: steps 1 to 7 in order    |
| `fixtures-capture.mjs` | `pnpm fixtures:capture`  | One deliberate Result_Page capture for the adapter fixtures |
| `lib/`                 | imported, never run      | The decision logic of the Start_Script, covered by Vitest   |

A workspace package rather than loose files at the repository root: that is what puts `scripts/` into the Turborepo task
graph, so `pnpm lint` and `pnpm test` reach these files the same way they reach every other package.

`pnpm start` does not end once it is done. Steps 6 and 7 start the API_Service and the Web_App as children of the
Start_Script, which then stays as their supervisor and keeps the address of the Web_App on screen; Ctrl+C ends all three
together. `pnpm start --offline` is the switch of 1.8: it skips step 1 and step 2 — the only two that need a network —
and begins with step 3.

## Why `start.mjs` is thin

`start.mjs` resolves the repository root, wires the real command runner, the real service launcher, the real HTTP probe,
the real filesystem access and the console Reporter into `lib/run-start.mjs`, and exits with the code that call returns.
That is the whole file. Every rule the requirements state — the order of the steps, is the working tree dirty, why did
the pull fail, which browser file is missing, is the database ready, which migration failed, is a service unreachable or
its port occupied, which failure is fatal, which exit code belongs to it — lives in `lib/`, where the Vitest suite
drives it with injected fakes and an injected clock. No test contacts a Git remote, runs an install, downloads a
browser, starts a container, applies a migration or brings up a server.

The order itself is in a module for the same reason as every single rule: as long as it sat in the top-level body of
`start.mjs` next to `process.exit`, it was the one part no test could reach, because importing the file would have run a
start. `runStart` returns an exit code instead of ending the process, so `run-start.test.mjs` can assert the claims that
belong to no single step — the seven steps in the order of 1.1, the configuration check before step 1, the container
runtime probe before step 4 announces itself, the two steps `--offline` skips, and the rule that a fatal step leaves
every later one unrun.

| Module                 | Owns                                                                                           |
| ---------------------- | ---------------------------------------------------------------------------------------------- |
| `run-start.mjs`        | The order of 1.1, the switch of 1.8, and the exit code the start ends with                     |
| `steps.mjs`            | The seven steps of 1.1 with their numbers                                                      |
| `start.messages.mjs`   | Every German console sentence (16.8)                                                           |
| `start-options.mjs`    | What the command line asked for: the `--offline` switch of 1.8                                 |
| `command-runner.mjs`   | The port for a command that ends: program plus arguments, captured output                      |
| `service-launcher.mjs` | The two ports for a service that does not end: a persistent child, and an HTTP request         |
| `reporter.mjs`         | The counting rule of 1.2: exactly one progress line per step, on stdout                        |
| `errors.mjs`           | The fatal error of 1.6, 1.7, 1.11, 1.13, 1.14 and 1.15, and the exit code table                |
| `outcomes.mjs`         | The closed value lists the steps return and the messages are keyed on                          |
| `readiness.mjs`        | The one bounded waiting loop: a look every 2 seconds, for at most 60 (1.11)                    |
| `env-check.mjs`        | Before step 1: every missing configuration key at once (1.12, 1.15)                            |
| `git-step.mjs`         | Step 1: the dirty-tree skip (1.3), the failure classification (1.4), nothing destructive (1.5) |
| `dependency-step.mjs`  | Step 2: `pnpm install` (1.6)                                                                   |
| `browser-step.mjs`     | Step 3: check the Chromium files, install only what is missing (1.7)                           |
| `postgres-step.mjs`    | Step 4: the runtime probe (1.13), reuse without a second container (1.10), the health gate     |
| `prisma-step.mjs`      | Step 5: `prisma migrate deploy`, and the name of a failed migration (1.14)                     |
| `service-step.mjs`     | What steps 6 and 7 share: the gate of 1.11, the stop on failure, the supervision after         |
| `api-step.mjs`         | Step 6: compile, start, and the `health` query that confirms the API_Service                   |
| `web-step.mjs`         | Step 7: serve the Web_App and print its callable address (1.9)                                 |

Two things about step 4 are worth knowing before changing it:

- the probe of the container runtime is a **precondition of step 4, not an eighth step**. 1.13 asks the start to stop
  _before_ step 4, so the probe runs before step 4 prints its progress line — and 1.1 fixes seven steps, so there is no
  number for a probe to claim;
- the host port of the container is **derived from `DATABASE_URL`** and handed to Compose through the child environment
  of the runner. `DATABASE_URL` stays the single source of truth for the connection, and a `VAR=value docker …` prefix
  is neither used nor possible: the runner spawns without a shell.

Five things about steps 6 and 7:

- the **configuration check runs before step 1**, not inside a step, for the same reason as the Docker probe: 1.1 fixes
  seven steps and there is no number for it to claim. It names every missing key at once (1.15), so an unfilled
  environment file costs a sentence instead of a pull, an install and a browser download first;
- the **list of required keys is not kept here**. `apps/api/src/config/env.schema.ts` declares it, the API_Service
  validates against it and `.env.example` documents it; `env-check.mjs` reads it out of that declaration, and the suite
  compares the result against `.env.example`. `POSTGRES_PORT` is deliberately not required: only docker-compose.yml
  reads it, and step 4 derives what it passes from `DATABASE_URL`;
- a **service is not a command**. `command-runner.mjs` resolves when its child exits, which is what confirms steps 1 to
  5 ready and would hang forever on a server. So a service is started through `service-launcher.mjs`, which hands back a
  handle — what has it printed, has it exited, stop it — and spawns into its own process group, because both services
  run behind `pnpm` and a signal to the package manager alone would leave a listener holding the port;
- **port occupied is told from unreachable by the text the service printed**, not by its exit code, which is `1` in both
  cases. Nest prints Node's `EADDRINUSE`; Vite prints `Port 5173 is already in use` and no error code at all.
  `service-output.fixture.mjs` holds both verbatim, which is what the classification is tested against;
- a service that was **already started is stopped** when a later step fails. 1.11 says the remaining steps are skipped
  and says nothing about the ones that ran, so this is a decision: a listener left behind would contradict the German
  message, would make the next start report an occupied port the user never caused, and would be a process the user
  cannot find. A service this start only _found_ running is reused and never stopped.

## Conventions

- Identifiers, comments and this file are English; every console line is German (16.8).
- A command is a program name plus an argument array, never a command line, so nothing passes through a shell.
  Multi-line shell logic belongs in a file, never inline. `command-vocabulary.test.mjs` asserts that shape for every
  command the modules declare — the program is one of `git`, `docker` and `pnpm`, no argument carries a chaining or
  redirecting character, no `VAR=value` stands in front of a program, only the two ports import `child_process`, and
  both spawn with `shell: false`.
- A step announces itself with `reporter.progress(step)` and prints no second line. Warnings and errors go to stderr, so
  stdout carries the progress lines and — once, at the end — the address line that 1.9 asks for, which is written
  through `reporter.info`.
