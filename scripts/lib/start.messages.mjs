/**
 * Every German sentence the Start_Script writes to the console.
 *
 * The design pins this: "German: every string the user reads in the Web_App, every console line of the
 * Start_Script", while every identifier, comment and log key stays English (16.8). The Web_App keeps its
 * strings in `apps/web/src/i18n/de.ts` and the API_Service keeps its failure sentences in
 * `apps/api/src/common/error-mapping.ts`; this module is the same idea for the console, and for the same
 * reason: a German literal sitting inside a branch is a sentence nobody can review against the
 * requirement that asks for it. Here they sit next to each other, each with its requirement named.
 *
 * Two conventions hold for every sentence below, taken from the existing German text:
 *
 * - it names the detected cause, including the line the failing tool reported, so the user does not have
 *   to go looking for output the Start_Script captured;
 * - it ends with exactly one next step, so a non-technical user is never left with a diagnosis and no
 *   instruction.
 *
 * What a warning says and what an error says differ on purpose, because 1.3 to 1.7 split them:
 * step 1 failures are warnings and the start continues with step 2, step 2 and step 3 failures are
 * errors and the start ends. The same split holds for the database steps: an unreachable container
 * runtime (1.13), a container that never reports itself ready (1.1) and a failed migration (1.14) are
 * errors, a `DATABASE_URL` whose port could not be read is a warning.
 *
 * The sentences of steps 6 and 7 follow the same split and add one more rule of their own: 1.11 asks
 * for the *name of the affected service* and for the *detected cause*, and it closes the list of causes
 * to two — the service is unreachable, or its port is occupied. {@link SERVICE_NAME_TEXT_DE} holds the
 * first, {@link serviceNotReadyError} the second, and neither invents a third cause.
 *
 * Requirements: 1.2, 1.3, 1.4, 1.6, 1.7, 1.8, 1.9, 1.10, 1.11, 1.13, 1.14, 1.15, 2.1, 16.8.
 */

import {
  CONTAINER_READINESS_DECISIONS,
  PULL_FAILURE_CAUSES,
  SERVICE_READINESS_DECISIONS,
} from './outcomes.mjs';
import { OFFLINE_FLAG, OFFLINE_SKIPPED_STEPS } from './start-options.mjs';
import { START_STEPS, TOTAL_STEP_COUNT } from './steps.mjs';

/** Stands in for a captured tool output that turned out to be empty. */
export const NO_OUTPUT_DE = 'keine Ausgabe';

/** How many changed files a dirty-tree warning names before it counts the rest (1.3). */
export const NAMED_CHANGE_LIMIT = 5;

/**
 * The progress text of every step, keyed by step id (1.2).
 *
 * One entry per step of 1.1 and no entry for anything else. The Reporter throws on a step without an
 * entry, which is what kept the unimplemented steps from printing a line before they existed, and what
 * now keeps a step id nobody declared from printing one.
 *
 * Worded for a user who does not know what a container, a migration or a dev server is: a "Datenbank"
 * that is started or kept, "Datenbankaktualisierungen" that are applied, a "Dienst" that does the
 * searching and an "Oberfläche" that is served.
 */
export const STEP_PROGRESS_TEXT_DE = Object.freeze({
  GIT_PULL: 'Projektstand aktualisieren, nur Fast-Forward',
  DEPENDENCY_INSTALL: 'Abhängigkeiten installieren',
  BROWSER_BINARIES: 'Browserdateien für die Suche prüfen und fehlende nachladen',
  POSTGRES_CONTAINER: 'Datenbank starten oder eine laufende weiterverwenden',
  PRISMA_MIGRATIONS: 'Offene Datenbankaktualisierungen einspielen',
  API_SERVICE: 'Dienst für Suche und Daten starten',
  WEB_APP: 'Oberfläche bereitstellen',
});

/**
 * The single progress line of one step (1.2).
 *
 * @param {import('./steps.mjs').StartStep} step
 * @param {string} text The German progress text of that step.
 * @returns {string}
 */
export function stepProgressLine(step, text) {
  return `Schritt ${String(step.number)} von ${String(TOTAL_STEP_COUNT)}: ${text} …`;
}

/**
 * German labels for the status letters of a changed file, so the dirty-tree warning of 1.3 names what
 * kind of change blocks the update instead of printing a two-letter code at a non-technical user.
 */
const CHANGE_LABELS_DE = Object.freeze({
  M: 'geändert',
  A: 'hinzugefügt',
  D: 'gelöscht',
  R: 'umbenannt',
  C: 'kopiert',
  T: 'Typ geändert',
  U: 'Konflikt',
});

/**
 * One changed file as "pfad (geändert)".
 *
 * @param {import('./git-step.mjs').WorkingTreeChange} change
 * @returns {string}
 */
export function describeChange(change) {
  const label = CHANGE_LABELS_DE[change.letter] ?? `Status ${change.code.trim()}`;

  return `${change.path} (${label})`;
}

/**
 * The changed files of a dirty working tree as one enumeration (1.3).
 *
 * Capped at {@link NAMED_CHANGE_LIMIT} entries plus a count of the rest: the warning has to *name* the
 * uncommitted changes, and a list of two hundred paths names nothing a reader can act on.
 *
 * @param {readonly import('./git-step.mjs').WorkingTreeChange[]} changes
 * @returns {string}
 */
export function describeChanges(changes) {
  const named = changes.slice(0, NAMED_CHANGE_LIMIT).map(describeChange).join(', ');
  const remaining = changes.length - Math.min(changes.length, NAMED_CHANGE_LIMIT);

  return remaining === 0 ? named : `${named} und ${String(remaining)} weitere`;
}

/**
 * Step 1 skipped because the working tree carries uncommitted changes (1.3).
 *
 * @param {readonly import('./git-step.mjs').WorkingTreeChange[]} changes
 * @returns {string}
 */
export function workingTreeDirtyWarning(changes) {
  return (
    `Hinweis: Die Aktualisierung wird übersprungen, weil es nicht gespeicherte Änderungen gibt: ` +
    `${describeChanges(changes)}. Diese Änderungen bleiben unverändert erhalten und der Start läuft ` +
    `mit dem vorhandenen Projektstand weiter. Nächster Schritt: Die Änderungen sichern, dann ` +
    `aktualisiert der nächste Start wieder.`
  );
}

/**
 * Step 1 skipped because the state of the working tree could not be read (1.4, 1.5).
 *
 * Not named by a requirement, but the alternative would be to update a working tree whose state is
 * unknown, and 1.5 forbids touching the local state in every case other than a fast-forward.
 *
 * @param {string} detail The line the tool reported.
 * @returns {string}
 */
export function workingTreeUnreadableWarning(detail) {
  return (
    `Hinweis: Die Aktualisierung wird übersprungen, weil der Zustand des Projektordners nicht ` +
    `gelesen werden konnte (gemeldet wurde: "${detail}"). Der lokale Projektstand bleibt unverändert ` +
    `und der Start läuft weiter. Nächster Schritt: Prüfen, ob der Projektordner vollständig vorhanden ` +
    `ist, und den Start danach erneut ausführen.`
  );
}

/** The detected cause of a failed update, in German, keyed by the classification of 1.4. */
const PULL_FAILURE_CAUSE_TEXT_DE = Object.freeze({
  [PULL_FAILURE_CAUSES.NO_NETWORK]: 'keine Netzwerkverbindung zur Projektquelle',
  [PULL_FAILURE_CAUSES.NO_FAST_FORWARD]:
    'keine Fast-Forward-Aktualisierung möglich, der lokale und der entfernte Stand sind auseinandergelaufen',
  [PULL_FAILURE_CAUSES.UNKNOWN]: 'unbekannt',
});

/** The one next step per detected cause (1.4). */
const PULL_FAILURE_NEXT_STEP_DE = Object.freeze({
  [PULL_FAILURE_CAUSES.NO_NETWORK]:
    'Die Netzwerkverbindung prüfen und den Start später erneut ausführen.',
  [PULL_FAILURE_CAUSES.NO_FAST_FORWARD]:
    'Die auseinandergelaufenen Stände von Hand zusammenführen; der Start verändert den Projektverlauf nicht.',
  [PULL_FAILURE_CAUSES.UNKNOWN]: 'Die gemeldete Zeile prüfen und den Start erneut ausführen.',
});

/**
 * The update failed; the detected cause is named and the start continues with step 2 (1.4, 1.5).
 *
 * @param {import('./git-step.mjs').PullFailure} failure
 * @returns {string}
 */
export function pullFailedWarning(failure) {
  const cause = PULL_FAILURE_CAUSE_TEXT_DE[failure.cause];
  const detail = failure.detail ?? NO_OUTPUT_DE;

  return (
    `Hinweis: Die Aktualisierung ist fehlgeschlagen, erkannte Ursache: ${cause} (gemeldet wurde: ` +
    `"${detail}"). Der lokale Projektstand bleibt unverändert und der Start läuft mit dem vorhandenen ` +
    `Stand weiter. Nächster Schritt: ${PULL_FAILURE_NEXT_STEP_DE[failure.cause]}`
  );
}

/**
 * An exit code as a German fragment. `null` happens when a tool could not be started at all or was
 * killed by a signal, and then there is no code to print.
 *
 * @param {number | null} exitCode
 * @returns {string}
 */
export function exitCodeText(exitCode) {
  return exitCode === null ? 'ohne Rückmeldung beendet' : `Rückmeldung ${String(exitCode)}`;
}

/**
 * `pnpm install` failed: the start ends here with a non-zero exit code (1.6).
 *
 * @param {{ detail: string | null, exitCode: number | null }} failure
 * @returns {string}
 */
export function dependencyInstallFailedError(failure) {
  return (
    `Fehler: Die Installation der Abhängigkeiten ist fehlgeschlagen (${exitCodeText(failure.exitCode)}). ` +
    `Gemeldete Ursache: "${failure.detail ?? NO_OUTPUT_DE}". Der Start wird abgebrochen, es wurde kein ` +
    `Dienst gestartet und keine Datenbank verändert. Nächster Schritt: Die gemeldete Ursache beheben und ` +
    `den Start erneut ausführen.`
  );
}

/**
 * The check of the browser files itself failed, so it is unknown whether they are complete (1.1, 1.7).
 *
 * Treated as an error and not as a warning because 1.1 lets a step begin only after the preceding step
 * is confirmed ready, and a check that did not run confirms nothing.
 *
 * @param {{ detail: string | null, exitCode: number | null }} failure
 * @returns {string}
 */
export function browserCheckFailedError(failure) {
  return (
    `Fehler: Die Browserdateien für die Suche konnten nicht geprüft werden ` +
    `(${exitCodeText(failure.exitCode)}). Gemeldete Ursache: "${failure.detail ?? NO_OUTPUT_DE}". Der ` +
    `Start wird abgebrochen, es wurde kein Dienst gestartet. Nächster Schritt: Die gemeldete Ursache ` +
    `beheben und den Start erneut ausführen.`
  );
}

/**
 * Installing a missing browser file failed: the start ends with a non-zero exit code (1.7).
 *
 * @param {{ titles: readonly string[], detail: string | null, exitCode: number | null }} failure
 * @returns {string}
 */
export function browserInstallFailedError(failure) {
  return (
    `Fehler: Die fehlenden Browserdateien konnten nicht installiert werden ` +
    `(${exitCodeText(failure.exitCode)}). Betroffen: ${failure.titles.join(', ')}. Gemeldete Ursache: ` +
    `"${failure.detail ?? NO_OUTPUT_DE}". Der Start wird abgebrochen, es wurde kein Dienst gestartet. ` +
    `Nächster Schritt: Die Netzwerkverbindung prüfen und den Start erneut ausführen.`
  );
}

/**
 * The installation reported success but a browser file is still missing (1.7).
 *
 * @param {readonly string[]} titles
 * @returns {string}
 */
export function browserStillMissingError(titles) {
  return (
    `Fehler: Nach der Installation fehlen weiterhin Browserdateien für die Suche. Betroffen: ` +
    `${titles.join(', ')}. Der Start wird abgebrochen, es wurde kein Dienst gestartet. Nächster ` +
    `Schritt: Den Start erneut ausführen; bleibt die Meldung, ist der Zwischenspeicher der ` +
    `Browserdateien beschädigt und muss gelöscht werden.`
  );
}

/** Names the step the container runtime probe guards, as the user sees it numbered (1.13). */
const POSTGRES_STEP_LABEL_DE = `Schritt ${String(START_STEPS.POSTGRES_CONTAINER.number)} von ${String(TOTAL_STEP_COUNT)}`;

/**
 * The container runtime is not reachable, so the start stops before step 4 (1.13).
 *
 * "Container-Laufzeit" with "Docker" named in the next step, as the design's error table words it: the
 * abstract term alone would tell a non-technical user nothing about what to click, and "Docker" alone
 * would not match the Steering_Docs, which call it the container runtime.
 *
 * @param {string | null} detail The line the probe reported.
 * @returns {string}
 */
export function containerRuntimeUnreachableError(detail) {
  return (
    `Fehler: Die Container-Laufzeit ist nicht erreichbar (gemeldet wurde: "${detail ?? NO_OUTPUT_DE}"). ` +
    `Der Start wird vor ${POSTGRES_STEP_LABEL_DE} abgebrochen, es wurde keine Datenbank gestartet und ` +
    `es wurden keine gespeicherten Daten verändert. Nächster Schritt: Docker starten und den Start ` +
    `erneut ausführen.`
  );
}

/**
 * `DATABASE_URL` is set but no host port could be read from it (step 4).
 *
 * A warning and not an error: the missing-key gate of 1.15 belongs to the environment file check (task
 * 20.3), and Compose still has the `POSTGRES_PORT` of the environment file to fall back on. Saying so
 * is what keeps the following connection failure in step 6 explainable.
 *
 * @param {string} detail What was found instead of a usable connection string.
 * @returns {string}
 */
export function databaseUrlUnusableWarning(detail) {
  return (
    `Hinweis: Aus der Einstellung DATABASE_URL konnte kein Datenbank-Port gelesen werden (gelesen ` +
    `wurde: "${detail}"). Die Datenbank wird mit dem Port aus der Umgebungsdatei gestartet, der davon ` +
    `abweichen kann. Nächster Schritt: DATABASE_URL in der Datei .env auf die Form ` +
    `postgresql://benutzer:passwort@127.0.0.1:55432/jobtool bringen.`
  );
}

/**
 * The PostgreSQL container could neither be started nor reused (1.1, 1.10).
 *
 * @param {{ detail: string | null, exitCode: number | null }} failure
 * @returns {string}
 */
export function postgresContainerFailedError(failure) {
  return (
    `Fehler: Die Datenbank konnte nicht gestartet werden (${exitCodeText(failure.exitCode)}). ` +
    `Gemeldete Ursache: "${failure.detail ?? NO_OUTPUT_DE}". Der Start wird abgebrochen, es wurde kein ` +
    `Dienst gestartet und es wurden keine gespeicherten Daten verändert. Nächster Schritt: Die ` +
    `gemeldete Ursache beheben; ist der Port bereits belegt, das Programm beenden, das ihn verwendet, ` +
    `und den Start erneut ausführen.`
  );
}

/** The detected cause per readiness decision of a container that is not ready (1.1). */
const CONTAINER_READINESS_CAUSE_TEXT_DE = Object.freeze({
  [CONTAINER_READINESS_DECISIONS.TIMED_OUT]:
    'die Datenbank hat sich im Wartefenster nicht als bereit gemeldet',
  [CONTAINER_READINESS_DECISIONS.UNHEALTHY]:
    'die Datenbank meldet ihre eigene Prüfung dauerhaft als fehlgeschlagen',
  [CONTAINER_READINESS_DECISIONS.STOPPED]: 'die Datenbank hat sich nach dem Start wieder beendet',
});

/** The one next step per readiness decision (1.1). */
const CONTAINER_READINESS_NEXT_STEP_DE = Object.freeze({
  [CONTAINER_READINESS_DECISIONS.TIMED_OUT]:
    'Den Start erneut ausführen; bleibt die Meldung, die Container-Laufzeit neu starten.',
  [CONTAINER_READINESS_DECISIONS.UNHEALTHY]:
    'Die Container-Laufzeit neu starten und den Start erneut ausführen.',
  [CONTAINER_READINESS_DECISIONS.STOPPED]:
    'Den freien Speicherplatz prüfen und den Start erneut ausführen.',
});

/**
 * The container did not confirm itself ready, so step 5 never begins (1.1).
 *
 * 1.1 lets a step begin only after the preceding one is confirmed ready, and an unconfirmed database is
 * the one case where applying a migration would be a guess. The sentence names the waited time, because
 * that is what distinguishes "not yet" from "never".
 *
 * @param {{ decision: string, status: string | null, waitedMs: number }} failure
 * @returns {string}
 */
export function postgresContainerNotReadyError(failure) {
  const cause = CONTAINER_READINESS_CAUSE_TEXT_DE[failure.decision];
  const seconds = Math.round(failure.waitedMs / 1000);

  return (
    `Fehler: Die Datenbank war nach ${String(seconds)} Sekunden nicht bereit, erkannte Ursache: ` +
    `${cause} (gemeldeter Zustand: "${failure.status ?? NO_OUTPUT_DE}"). Der Start wird abgebrochen, es ` +
    `wurde kein Dienst gestartet und es wurden keine gespeicherten Daten verändert. Nächster Schritt: ` +
    `${CONTAINER_READINESS_NEXT_STEP_DE[failure.decision]}`
  );
}

/** Stands in for a failed migration whose name the tool output did not reveal (1.14). */
export const UNKNOWN_MIGRATION_DE = 'nicht ermittelbar';

/**
 * A pending migration failed to apply (1.14).
 *
 * The requirement asks for the *name* of the failed migration, so the name is the first thing the
 * sentence carries, followed by the database error that actually rejected it. The promise that the
 * stored data is unchanged is part of the text because it is the thing the user is afraid of: a
 * migration that fails runs in a transaction Prisma rolls back, and neither the API_Service nor the
 * Web_App is started afterwards.
 *
 * @param {{ migrationName: string | null, errorCode: string | null, detail: string | null,
 *   exitCode: number | null }} failure
 * @returns {string}
 */
export function prismaMigrationFailedError(failure) {
  const code = failure.errorCode === null ? '' : ` (${failure.errorCode})`;

  return (
    `Fehler: Eine offene Datenbankaktualisierung ist fehlgeschlagen. Betroffene Aktualisierung: ` +
    `"${failure.migrationName ?? UNKNOWN_MIGRATION_DE}"${code}. Gemeldete Ursache: ` +
    `"${failure.detail ?? NO_OUTPUT_DE}" (${exitCodeText(failure.exitCode)}). Der Start wird ` +
    `abgebrochen, es wurde weder der Dienst noch die Oberfläche gestartet und die gespeicherten Daten ` +
    `bleiben unverändert. Nächster Schritt: Die gemeldete Ursache in der genannten Aktualisierung ` +
    `beheben und den Start erneut ausführen.`
  );
}

/** The name of the environment file, as `.gitignore` excludes it and `.env.example` documents it. */
export const ENV_FILE_NAME_DE = '.env';

/**
 * Required configuration keys are missing or empty (1.12, 1.15).
 *
 * *Every* missing key is named, not the first one: a user who has just copied the template is missing
 * all of them, and reporting them one start at a time would cost fourteen starts. The keys are printed
 * as they are spelled in the file, because that is what the user has to search for; no value is ever
 * printed, which is what keeps the API keys and the database password off the console (14.9).
 *
 * @param {readonly string[]} missingKeys In the order of `.env.example`.
 * @returns {string}
 */
export function environmentKeysMissingError(missingKeys) {
  return (
    `Fehler: In der Umgebungsdatei ${ENV_FILE_NAME_DE} fehlen Einstellungen oder sie sind leer: ` +
    `${missingKeys.join(', ')}. Der Start wird vor Schritt 1 von ${String(TOTAL_STEP_COUNT)} ` +
    `abgebrochen, es wurde kein Dienst gestartet und es wurden keine gespeicherten Daten verändert. ` +
    `Nächster Schritt: Die Datei .env.example nach ${ENV_FILE_NAME_DE} kopieren, sofern noch nicht ` +
    `vorhanden, und die genannten Einstellungen dort ausfüllen.`
  );
}

/**
 * A port the Start_Script itself needs is present but unusable (1.9, 1.11).
 *
 * Only these two keys are checked for their value, and only because the Start_Script cannot do its own
 * job without them: 1.9 asks it to print the Web_App address, and 1.11 asks it to probe both services,
 * and neither is possible without a port number. Every other value is the API_Service's business, which
 * validates and reports it under 1.15 on its own.
 *
 * @param {readonly string[]} keys
 * @returns {string}
 */
export function environmentPortUnusableError(keys) {
  return (
    `Fehler: In der Umgebungsdatei ${ENV_FILE_NAME_DE} ist keine gültige Portnummer eingetragen: ` +
    `${keys.join(', ')}. Der Start wird abgebrochen, es wurde kein Dienst gestartet. Nächster ` +
    `Schritt: Die genannten Einstellungen in ${ENV_FILE_NAME_DE} auf die Portnummern aus ` +
    `.env.example bringen und den Start erneut ausführen.`
  );
}

/**
 * The list of required keys could not be read from the API_Service (defect, not a user error).
 *
 * The Start_Script does not keep its own copy of that list — it reads it where it is defined — so this
 * is what a renamed file or a changed declaration looks like from the outside. The sentence is German
 * like every console line, but its next step points at the development, because nothing the user can
 * edit would fix it.
 *
 * @param {string} detail
 * @returns {string}
 */
export function environmentKeyListUnreadableError(detail) {
  return (
    `Fehler: Die Liste der benötigten Einstellungen konnte nicht gelesen werden (gemeldet wurde: ` +
    `"${detail}"). Der Start wird abgebrochen, es wurde kein Dienst gestartet. Nächster Schritt: Die ` +
    `gemeldete Zeile an die Entwicklung weitergeben.`
  );
}

/**
 * Steps 1 and 2 were skipped because the user asked for it (1.8).
 *
 * A hint on stderr and not a progress line: the two steps do not run, and 1.2 gives a line to a step
 * that runs. Saying it at all matters because the consequence is silent otherwise — the start then
 * works with the project state and the dependencies that happen to be on the machine.
 *
 * @returns {string}
 */
export function offlineModeWarning() {
  const skipped = OFFLINE_SKIPPED_STEPS.map(
    (step) =>
      `Schritt ${String(step.number)} von ${String(TOTAL_STEP_COUNT)} (${STEP_PROGRESS_TEXT_DE[step.id]})`,
  ).join(' und ');

  return (
    `Hinweis: Auf Wunsch (${OFFLINE_FLAG}) überspringt der Start ${skipped} und beginnt mit Schritt ` +
    `${String(START_STEPS.BROWSER_BINARIES.number)} von ${String(TOTAL_STEP_COUNT)}. Projektstand und ` +
    `Abhängigkeiten bleiben auf dem Stand dieses Rechners. Nächster Schritt: Den Start ohne ` +
    `${OFFLINE_FLAG} ausführen, sobald eine Netzwerkverbindung besteht.`
  );
}

/**
 * An argument the Start_Script does not understand (1.8).
 *
 * @param {readonly string[]} unknownArguments
 * @returns {string}
 */
export function unknownArgumentWarning(unknownArguments) {
  return (
    `Hinweis: Diese Angaben wurden nicht verstanden und bleiben ohne Wirkung: ` +
    `${unknownArguments.join(', ')}. Der Start läuft mit allen Schritten weiter. Nächster Schritt: ` +
    `Den Start ohne diese Angaben ausführen; der einzige Schalter ist ${OFFLINE_FLAG}.`
  );
}

/** German name of each service, so 1.11 can name the affected one. Capitalised: each leads a sentence. */
export const SERVICE_NAME_TEXT_DE = Object.freeze({
  [START_STEPS.API_SERVICE.id]: 'Der Dienst für Suche und Daten (API_Service)',
  [START_STEPS.WEB_APP.id]: 'Die Oberfläche (Web_App)',
});

/**
 * The API_Service could not be compiled, so step 6 had nothing to start (1.1).
 *
 * @param {{ detail: string | null, exitCode: number | null }} failure
 * @returns {string}
 */
export function apiServiceBuildFailedError(failure) {
  return (
    `Fehler: Der Dienst für Suche und Daten konnte nicht vorbereitet werden ` +
    `(${exitCodeText(failure.exitCode)}). Gemeldete Ursache: "${failure.detail ?? NO_OUTPUT_DE}". Der ` +
    `Start wird abgebrochen, es wurde kein Dienst gestartet und es wurden keine gespeicherten Daten ` +
    `verändert. Nächster Schritt: Die gemeldete Ursache beheben und den Start erneut ausführen.`
  );
}

/** The detected cause per readiness decision, closed to the two causes 1.11 names. */
const SERVICE_READINESS_CAUSE_TEXT_DE = Object.freeze({
  [SERVICE_READINESS_DECISIONS.PORT_OCCUPIED]: (port) => `Port ${String(port)} ist belegt`,
  [SERVICE_READINESS_DECISIONS.UNREACHABLE]: () =>
    'nicht erreichbar, das Programm hat sich beim Starten beendet',
  [SERVICE_READINESS_DECISIONS.TIMED_OUT]: () =>
    'nicht erreichbar, das Programm hat im Wartefenster nicht geantwortet',
});

/** The one next step per detected cause (1.11). */
const SERVICE_READINESS_NEXT_STEP_DE = Object.freeze({
  [SERVICE_READINESS_DECISIONS.PORT_OCCUPIED]: (port) =>
    `Das Programm beenden, das Port ${String(port)} verwendet, und den Start erneut ausführen.`,
  [SERVICE_READINESS_DECISIONS.UNREACHABLE]: () =>
    'Die gemeldete Ursache beheben und den Start erneut ausführen.',
  [SERVICE_READINESS_DECISIONS.TIMED_OUT]: () =>
    'Den Start erneut ausführen; bleibt die Meldung, den Rechner neu starten.',
});

/**
 * A service did not become ready within the waiting window (1.11).
 *
 * Carries all four things 1.11 asks for: the affected service by name, the detected cause from the
 * closed list of two, the fact that the remaining steps are skipped, and — because it is the question
 * the user asks next — what happened to whatever was already started.
 *
 * @param {{ step: import('./steps.mjs').StartStep, decision: string, port: number | string,
 *   detail: string | null, waitedMs: number, stoppedServices: number }} failure
 * @returns {string}
 */
export function serviceNotReadyError(failure) {
  const seconds = Math.round(failure.waitedMs / 1000);
  const cause = SERVICE_READINESS_CAUSE_TEXT_DE[failure.decision](failure.port);
  const stopped =
    failure.stoppedServices === 0
      ? 'es wurde kein Dienst gestartet'
      : 'bereits gestartete Programme wurden wieder beendet';

  return (
    `Fehler: ${SERVICE_NAME_TEXT_DE[failure.step.id]} war nach ${String(seconds)} Sekunden nicht ` +
    `bereit, erkannte Ursache: ${cause} (gemeldet wurde: "${failure.detail ?? NO_OUTPUT_DE}"). Der ` +
    `Start wird in Schritt ${String(failure.step.number)} von ${String(TOTAL_STEP_COUNT)} ` +
    `abgebrochen, die verbleibenden Schritte werden übersprungen und ${stopped}. Nächster Schritt: ` +
    `${SERVICE_READINESS_NEXT_STEP_DE[failure.decision](failure.port)}`
  );
}

/**
 * A service from an earlier start was found answering and is reused.
 *
 * The same consideration 1.10 makes for the database, applied to a service: starting a second one would
 * fail on the occupied port and would tell the user about a problem they do not have. The next step is
 * the honest consequence of reusing it — the running service keeps the code it was started with.
 *
 * @param {{ step: import('./steps.mjs').StartStep, port: number | string }} service
 * @returns {string}
 */
export function serviceAlreadyRunningWarning(service) {
  return (
    `Hinweis: ${SERVICE_NAME_TEXT_DE[service.step.id]} antwortet bereits auf Port ` +
    `${String(service.port)} und wird weiterverwendet; es wurde kein zweites Programm gestartet. ` +
    `Nächster Schritt: Nichts tun; soll ein aktualisierter Projektstand wirksam werden, das laufende ` +
    `Programm beenden und den Start erneut ausführen.`
  );
}

/**
 * The complete callable local URL of the Web_App (1.9).
 *
 * "Complete and callable" is taken literally: scheme, host and the configured port, so the line can be
 * copied into a browser as it stands. It is printed the moment the readiness gate of step 7 confirms
 * the Web_App, which is at most one poll interval after it began accepting requests and therefore
 * inside the 5 seconds of 1.9.
 *
 * @param {string} url
 * @returns {string}
 */
export function webAppReadyLine(url) {
  return `Fertig: Die Oberfläche ist unter ${url} erreichbar. Diese Adresse im Browser öffnen.`;
}

/**
 * A service that had confirmed itself ready ended on its own afterwards.
 *
 * Not a case any requirement names, and the alternative would be worse than a message: an API_Service
 * that has died leaves an Oberfläche that loads and then fails every action, which 2.5 would have to
 * explain in the Web_App instead.
 *
 * @param {{ step: import('./steps.mjs').StartStep, detail: string | null,
 *   exitCode: number | null }} failure
 * @returns {string}
 */
export function serviceStoppedError(failure) {
  return (
    `Fehler: ${SERVICE_NAME_TEXT_DE[failure.step.id]} hat sich nach dem Start beendet ` +
    `(${exitCodeText(failure.exitCode)}). Gemeldete Ursache: "${failure.detail ?? NO_OUTPUT_DE}". Die ` +
    `übrigen Programme wurden ebenfalls beendet, damit keine halb laufende Oberfläche zurückbleibt. ` +
    `Nächster Schritt: Die gemeldete Ursache beheben und den Start erneut ausführen.`
  );
}

/**
 * The user ended the start, so the services it had started are ended with it.
 *
 * @returns {string}
 */
export function shutdownRequestedWarning() {
  return (
    `Hinweis: Der Start wird beendet; die gestarteten Programme werden gestoppt und die ` +
    `gespeicherten Daten bleiben unverändert. Nächster Schritt: Für eine neue Sitzung "pnpm start" ` +
    `erneut ausführen.`
  );
}

/**
 * The Start_Script ended on a failure that no step classified (unexpected defect, not a requirement).
 *
 * @param {string} detail
 * @returns {string}
 */
export function unexpectedFailureError(detail) {
  return (
    `Fehler: Der Start wurde durch einen unerwarteten Fehler abgebrochen (gemeldet wurde: ` +
    `"${detail}"). Es wurde kein Dienst gestartet. Nächster Schritt: Die gemeldete Zeile an die ` +
    `Entwicklung weitergeben.`
  );
}
