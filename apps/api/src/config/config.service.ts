import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { commuteThresholdRejectedMessageDe } from './config.messages';
import { ENV_CONFIG } from './env.config';
import { commuteThresholdSchema, describeEnvConfig, type EnvConfig } from './env.schema';

/** `Setting.key` of the Home_Address. */
export const SETTING_KEY_HOME_ADDRESS = 'homeAddress';

/** `Setting.key` of the Commute_Threshold in minutes. */
export const SETTING_KEY_COMMUTE_THRESHOLD_MINUTES = 'commuteThresholdMinutes';

/** The two keys the `Setting` table holds, as the single list both the read and the write use. */
export const CONFIGURABLE_SETTING_KEYS = [
  SETTING_KEY_HOME_ADDRESS,
  SETTING_KEY_COMMUTE_THRESHOLD_MINUTES,
] as const;

/** Default Home_Address of the Job_Tool (8.10). */
export const DEFAULT_HOME_ADDRESS = 'Hörkherstraße 1d, 80689 München';

/** Default Commute_Threshold in minutes (8.10). */
export const DEFAULT_COMMUTE_THRESHOLD_MINUTES = 60;

/**
 * The part of the Posting_Store client this service needs.
 *
 * Narrowing the dependency to the `Setting` delegate is what lets a test drive the resolution
 * against a stand-in store without a database, while dependency injection still hands over the
 * real `PrismaService`. The class is imported as a value for that reason: it is the injection
 * token, and `apps/api/src/prisma/prisma.service.ts` stays its only definition.
 */
export type SettingStore = Pick<PrismaService, 'setting'>;

/**
 * The effective configuration of the API_Service.
 *
 * Two layers meet here. The environment file is the configuration *input*: validated once at
 * startup and already known to be complete when this service is constructed. The `Setting` table
 * is the last *accepted* state of the two configurable values, Home_Address and Commute_Threshold
 * (8.10).
 *
 * The table is what makes a rejected configuration change implementable (8.14). A
 * `COMMUTE_THRESHOLD_MINUTES` that is not an integer from 5 to 240 reaches this service as `null`;
 * the previously accepted value is then read back from the table, stays in force, and the user
 * gets a German message naming the permitted range. Without the stored row there would be no
 * "previous value" to retain after a restart — the process has no memory of the edit the user just
 * made. A valid value is written back, so the next start has something to fall back to.
 *
 * Home_Address is mirrored the same way, but its invalid case is empty, and an empty required key
 * already stops the startup (1.15). So the mirror is a seed and a record, not a fallback path.
 *
 * Consumers read `homeAddress` and `commuteThresholdMinutes` from here rather than from the
 * environment, because only this service knows which of the two sources won.
 *
 * Requirements: 1.12, 8.10, 8.14, 14.9.
 */
@Injectable()
export class AppConfigService implements OnModuleInit {
  private readonly logger = new Logger(AppConfigService.name);

  private resolvedHomeAddress: string;

  private resolvedCommuteThresholdMinutes: number;

  constructor(
    @Inject(ENV_CONFIG) public readonly env: EnvConfig,
    @Inject(PrismaService) private readonly prisma: SettingStore,
  ) {
    // Starting values, in force until the resolution against the `Setting` table has run. They
    // keep the service usable in a unit test that never initialises the module, and they are the
    // documented defaults (8.10) rather than placeholders.
    this.resolvedHomeAddress = env.homeAddress;
    this.resolvedCommuteThresholdMinutes =
      env.commuteThresholdMinutes ?? DEFAULT_COMMUTE_THRESHOLD_MINUTES;
  }

  /**
   * Resolves the configurable pair before the first request is served.
   *
   * A failure to read the `Setting` table is not caught: the Posting_Store is required for every
   * function of the Job_Tool, and starting with an unresolved configuration would hide a broken
   * database behind a working `health` query.
   */
  async onModuleInit(): Promise<void> {
    await this.resolveConfigurableValues();
  }

  /** The Home_Address every commute determination starts from (8.10). */
  get homeAddress(): string {
    return this.resolvedHomeAddress;
  }

  /** The Commute_Threshold in minutes, always an integer from 5 to 240 (8.10). */
  get commuteThresholdMinutes(): number {
    return this.resolvedCommuteThresholdMinutes;
  }

  /** The effective configuration with every credential masked, safe to log (14.9). */
  describeForLog(): Readonly<Record<string, string | number | boolean | null>> {
    return {
      ...describeEnvConfig(this.env),
      homeAddress: this.resolvedHomeAddress,
      commuteThresholdMinutes: this.resolvedCommuteThresholdMinutes,
    };
  }

  /**
   * Reads the last accepted pair, decides what stays in force and writes the result back.
   *
   * Public because the startup path is not the only caller that matters: a test resolves without
   * building a Nest module, and the Testcontainers harness of a later task re-resolves against a
   * freshly migrated database.
   */
  async resolveConfigurableValues(): Promise<void> {
    const stored = await this.prisma.setting.findMany({
      where: { key: { in: [...CONFIGURABLE_SETTING_KEYS] } },
    });
    const storedValueOf = (key: string): string | undefined =>
      stored.find((setting) => setting.key === key)?.value;

    this.resolvedHomeAddress = this.resolveHomeAddress(storedValueOf(SETTING_KEY_HOME_ADDRESS));
    this.resolvedCommuteThresholdMinutes = this.resolveCommuteThreshold(
      storedValueOf(SETTING_KEY_COMMUTE_THRESHOLD_MINUTES),
    );

    await this.persistAccepted(SETTING_KEY_HOME_ADDRESS, this.resolvedHomeAddress, stored);
    await this.persistAccepted(
      SETTING_KEY_COMMUTE_THRESHOLD_MINUTES,
      String(this.resolvedCommuteThresholdMinutes),
      stored,
    );

    this.logger.log(`Effective configuration: ${JSON.stringify(this.describeForLog())}`);
  }

  /**
   * The environment value wins; the stored value and the default only cover its absence.
   *
   * An empty `HOME_ADDRESS` never reaches this point, so the fallbacks exist for the case where a
   * later task resolves the pair against a database that was seeded by an earlier version.
   */
  private resolveHomeAddress(storedValue: string | undefined): string {
    const candidates = [this.env.homeAddress, storedValue?.trim(), DEFAULT_HOME_ADDRESS];

    return candidates.find((candidate): candidate is string => (candidate ?? '') !== '') ?? '';
  }

  /**
   * Keeps the previously accepted Commute_Threshold when the configured one was rejected (8.14).
   *
   * The stored value is re-validated rather than trusted: it is a string column, and a row edited
   * by hand must not be able to put an out-of-range threshold into force through the back door.
   */
  private resolveCommuteThreshold(storedValue: string | undefined): number {
    if (this.env.commuteThresholdMinutes !== null) {
      return this.env.commuteThresholdMinutes;
    }

    const stored = commuteThresholdSchema.safeParse((storedValue ?? '').trim());
    const retained = stored.success ? stored.data : DEFAULT_COMMUTE_THRESHOLD_MINUTES;

    // German, because this is the error hint 8.14 asks for and the user is the one who edited the
    // value. The English code is what the Log_Stream will carry once it exists.
    this.logger.error(
      `config.commuteThresholdInvalid: ${commuteThresholdRejectedMessageDe(retained)}`,
    );

    return retained;
  }

  /**
   * Seeds a `Setting` row on the first start and records a changed value afterwards (8.10).
   *
   * An unchanged value is not written, so `updatedAt` keeps meaning "when this value was last
   * accepted" instead of "when the API_Service last started".
   */
  private async persistAccepted(
    key: string,
    value: string,
    stored: readonly { readonly key: string; readonly value: string }[],
  ): Promise<void> {
    if (stored.find((setting) => setting.key === key)?.value === value) {
      return;
    }

    await this.prisma.setting.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });

    this.logger.log(`Accepted configuration value stored: ${key}`);
  }
}
