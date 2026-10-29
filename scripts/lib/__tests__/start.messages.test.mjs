/**
 * The German console text of the Start_Script (1.2, 1.3, 1.4, 1.6, 1.7, 16.8).
 *
 * Two things are asserted about every sentence rather than about a chosen one: it names the cause, and
 * it ends with exactly one next step. The wording itself is reviewed in `start.messages.mjs`, where each
 * sentence sits under the requirement that asks for it.
 */

import { describe, expect, it } from 'vitest';

import {
  CONTAINER_READINESS_DECISIONS,
  PULL_FAILURE_CAUSES,
  SERVICE_READINESS_DECISIONS,
} from '../outcomes.mjs';
import {
  apiServiceBuildFailedError,
  browserCheckFailedError,
  browserInstallFailedError,
  browserStillMissingError,
  containerRuntimeUnreachableError,
  databaseUrlUnusableWarning,
  dependencyInstallFailedError,
  describeChanges,
  environmentKeyListUnreadableError,
  environmentKeysMissingError,
  environmentPortUnusableError,
  NAMED_CHANGE_LIMIT,
  NO_OUTPUT_DE,
  offlineModeWarning,
  postgresContainerFailedError,
  postgresContainerNotReadyError,
  prismaMigrationFailedError,
  pullFailedWarning,
  serviceAlreadyRunningWarning,
  serviceNotReadyError,
  serviceStoppedError,
  shutdownRequestedWarning,
  stepProgressLine,
  UNKNOWN_MIGRATION_DE,
  unknownArgumentWarning,
  webAppReadyLine,
  workingTreeDirtyWarning,
  workingTreeUnreadableWarning,
} from '../start.messages.mjs';
import { OFFLINE_FLAG } from '../start-options.mjs';
import { START_STEPS } from '../steps.mjs';

/** A change entry as `parseWorkingTreeStatus` produces it. */
function change(path, letter = 'M') {
  return { code: ` ${letter}`, letter, path, untracked: false };
}

const EVERY_MESSAGE = [
  workingTreeDirtyWarning([change('apps/api/src/main.ts')]),
  workingTreeUnreadableWarning('fatal: not a git repository'),
  ...Object.values(PULL_FAILURE_CAUSES).map((cause) =>
    pullFailedWarning({ cause, detail: 'fatal: beispiel', timedOut: false }),
  ),
  dependencyInstallFailedError({ detail: 'ERR_PNPM_EXAMPLE', exitCode: 1 }),
  browserCheckFailedError({ detail: 'Command failed', exitCode: 1 }),
  browserInstallFailedError({
    titles: ['Chrome for Testing'],
    detail: 'Download failure',
    exitCode: 1,
  }),
  browserStillMissingError(['Chrome Headless Shell']),
  containerRuntimeUnreachableError('Cannot connect to the Docker daemon'),
  databaseUrlUnusableWarning('bitte-hier-eintragen'),
  postgresContainerFailedError({ detail: 'port already allocated', exitCode: 1 }),
  ...[
    CONTAINER_READINESS_DECISIONS.TIMED_OUT,
    CONTAINER_READINESS_DECISIONS.UNHEALTHY,
    CONTAINER_READINESS_DECISIONS.STOPPED,
  ].map((decision) =>
    postgresContainerNotReadyError({ decision, status: 'Up 1 second', waitedMs: 60_000 }),
  ),
  prismaMigrationFailedError({
    migrationName: '20261027173123_init',
    errorCode: 'P3018',
    detail: 'ERROR: column "doesNotExist" does not exist',
    exitCode: 1,
  }),
  environmentKeysMissingError(['DATABASE_URL', 'API_PORT']),
  environmentPortUnusableError(['WEB_PORT']),
  environmentKeyListUnreadableError('apps/api/src/config/env.schema.ts nicht lesbar'),
  offlineModeWarning(),
  unknownArgumentWarning(['--ofline']),
  apiServiceBuildFailedError({ detail: 'error TS2345: beispiel', exitCode: 1 }),
  ...[START_STEPS.API_SERVICE, START_STEPS.WEB_APP].flatMap((step) => [
    ...[
      SERVICE_READINESS_DECISIONS.PORT_OCCUPIED,
      SERVICE_READINESS_DECISIONS.UNREACHABLE,
      SERVICE_READINESS_DECISIONS.TIMED_OUT,
    ].map((decision) =>
      serviceNotReadyError({
        step,
        decision,
        port: 4000,
        detail: 'Error: listen EADDRINUSE: address already in use 127.0.0.1:4000',
        waitedMs: 60_000,
        stoppedServices: 1,
      }),
    ),
    serviceAlreadyRunningWarning({ step, port: 4000 }),
    serviceStoppedError({ step, detail: 'Error: beispiel', exitCode: 1 }),
  ]),
  shutdownRequestedWarning(),
];

describe('the German console text', () => {
  it('ends every warning and every error with exactly one next step', () => {
    for (const message of EVERY_MESSAGE) {
      expect(message.match(/Nächster Schritt:/g)).toHaveLength(1);
      expect(message.endsWith('.')).toBe(true);
    }
  });

  it('writes every warning and every error as a single console line', () => {
    for (const message of EVERY_MESSAGE) {
      expect(message).not.toContain('\n');
    }
  });

  it('numbers a progress line within the seven steps of 1.1', () => {
    expect(stepProgressLine(START_STEPS.API_SERVICE, 'Dienst starten')).toBe(
      'Schritt 6 von 7: Dienst starten …',
    );
  });

  it('names the uncommitted changes with their kind of change', () => {
    const warning = workingTreeDirtyWarning([
      change('apps/api/src/main.ts'),
      change('packages/domain/src/gone.ts', 'D'),
    ]);

    expect(warning).toContain('apps/api/src/main.ts (geändert)');
    expect(warning).toContain('packages/domain/src/gone.ts (gelöscht)');
  });

  it('names at most five changed files and counts the rest', () => {
    const changes = Array.from({ length: NAMED_CHANGE_LIMIT + 3 }, (_unused, index) =>
      change(`datei-${String(index)}.ts`),
    );

    expect(describeChanges(changes)).toContain('und 3 weitere');
    expect(describeChanges(changes.slice(0, NAMED_CHANGE_LIMIT))).not.toContain('weitere');
  });

  it('says so when the failing tool printed nothing', () => {
    expect(dependencyInstallFailedError({ detail: null, exitCode: 1 })).toContain(NO_OUTPUT_DE);
    expect(
      pullFailedWarning({
        cause: PULL_FAILURE_CAUSES.NO_NETWORK,
        detail: null,
        timedOut: true,
      }),
    ).toContain(NO_OUTPUT_DE);
  });

  it('tells the user to start the container runtime when it is unreachable (1.13)', () => {
    const error = containerRuntimeUnreachableError('Cannot connect to the Docker daemon');

    expect(error).toContain('Container-Laufzeit ist nicht erreichbar');
    expect(error).toContain('Cannot connect to the Docker daemon');
    expect(error).toContain('Nächster Schritt: Docker starten');
    expect(error).toContain('Schritt 4 von 7');
  });

  it('names the failed migration and promises the stored data is unchanged (1.14)', () => {
    const error = prismaMigrationFailedError({
      migrationName: '20261027173123_init',
      errorCode: 'P3018',
      detail: 'ERROR: relation "Posting" already exists',
      exitCode: 1,
    });

    expect(error).toContain('"20261027173123_init" (P3018)');
    expect(error).toContain('ERROR: relation "Posting" already exists');
    expect(error).toContain('gespeicherten Daten bleiben unverändert');
  });

  it('says so when the failed migration cannot be named (1.14)', () => {
    expect(
      prismaMigrationFailedError({
        migrationName: null,
        errorCode: null,
        detail: null,
        exitCode: null,
      }),
    ).toContain(UNKNOWN_MIGRATION_DE);
  });

  it('names the waited time of a database that never became ready (1.1)', () => {
    expect(
      postgresContainerNotReadyError({
        decision: CONTAINER_READINESS_DECISIONS.TIMED_OUT,
        status: 'Up 1 second (health: starting)',
        waitedMs: 60_000,
      }),
    ).toContain('nach 60 Sekunden nicht bereit');
  });

  it('names every missing configuration key at once, and no value (1.15, 14.9)', () => {
    const error = environmentKeysMissingError(['DATABASE_URL', 'ANTHROPIC_API_KEY', 'API_PORT']);

    expect(error).toContain('DATABASE_URL, ANTHROPIC_API_KEY, API_PORT');
    expect(error).toContain('.env.example');
    expect(error).toContain('kein Dienst gestartet');
  });

  it('names the affected service and the detected cause of a failed gate (1.11)', () => {
    const occupied = serviceNotReadyError({
      step: START_STEPS.API_SERVICE,
      decision: SERVICE_READINESS_DECISIONS.PORT_OCCUPIED,
      port: 4000,
      detail: 'Error: listen EADDRINUSE: address already in use 127.0.0.1:4000',
      waitedMs: 4_000,
      stoppedServices: 0,
    });

    expect(occupied).toContain('Der Dienst für Suche und Daten (API_Service)');
    expect(occupied).toContain('Port 4000 ist belegt');
    expect(occupied).toContain('nach 4 Sekunden nicht bereit');
    expect(occupied).toContain('Schritt 6 von 7');
    expect(occupied).toContain('verbleibenden Schritte werden übersprungen');
    expect(occupied).toContain('Nächster Schritt: Das Programm beenden, das Port 4000 verwendet');
  });

  it('calls a service that never answered unreachable rather than occupied (1.11)', () => {
    const unreachable = serviceNotReadyError({
      step: START_STEPS.WEB_APP,
      decision: SERVICE_READINESS_DECISIONS.TIMED_OUT,
      port: 5173,
      detail: null,
      waitedMs: 60_000,
      stoppedServices: 1,
    });

    expect(unreachable).toContain('Die Oberfläche (Web_App)');
    expect(unreachable).toContain('nicht erreichbar');
    expect(unreachable).not.toContain('belegt');
    expect(unreachable).toContain('nach 60 Sekunden');
    expect(unreachable).toContain('bereits gestartete Programme wurden wieder beendet');
    expect(unreachable).toContain(NO_OUTPUT_DE);
  });

  it('says that nothing was started when nothing had been (1.11)', () => {
    expect(
      serviceNotReadyError({
        step: START_STEPS.API_SERVICE,
        decision: SERVICE_READINESS_DECISIONS.UNREACHABLE,
        port: 4000,
        detail: 'Error: beispiel',
        waitedMs: 2_000,
        stoppedServices: 0,
      }),
    ).toContain('es wurde kein Dienst gestartet');
  });

  it('prints the complete callable address of the Web_App (1.9)', () => {
    const line = webAppReadyLine('http://127.0.0.1:5173/');

    expect(line).toContain('http://127.0.0.1:5173/');
    expect(line).toContain('im Browser öffnen');
    expect(line).not.toContain('\n');
  });

  it('names the two steps the offline switch skips and where the start begins (1.8)', () => {
    const warning = offlineModeWarning();

    expect(warning).toContain(OFFLINE_FLAG);
    expect(warning).toContain('Schritt 1 von 7');
    expect(warning).toContain('Schritt 2 von 7');
    expect(warning).toContain('beginnt mit Schritt 3 von 7');
  });

  it('names the detected cause of a failed update', () => {
    expect(
      pullFailedWarning({
        cause: PULL_FAILURE_CAUSES.NO_NETWORK,
        detail: 'fatal: Could not resolve host',
        timedOut: false,
      }),
    ).toContain('keine Netzwerkverbindung');
    expect(
      pullFailedWarning({
        cause: PULL_FAILURE_CAUSES.NO_FAST_FORWARD,
        detail: 'fatal: Not possible to fast-forward, aborting.',
        timedOut: false,
      }),
    ).toContain('Fast-Forward');
  });
});
