/**
 * An in-memory stand-in for the `Setting` delegate of the Posting_Store.
 *
 * `AppConfigService` narrows its dependency to `Pick<PrismaService, 'setting'>`, which is what lets
 * the retention of the last accepted Commute_Threshold (8.14) be driven without a database: the
 * resolution logic under test is the real one, only the storage is a map. The recorded `writes`
 * make the second half of 8.10 observable — an unchanged value is not written back, so a rejected
 * change cannot quietly overwrite the row it is supposed to fall back to.
 *
 * Not a test file: the name keeps it out of the Vitest discovery pattern so the two suites in this
 * directory can share it. The Testcontainers harness of a later task exercises the same service
 * against PostgreSQL.
 *
 * Requirements: 8.10, 8.14.
 */

import type { SettingStore } from '../config.service';

/** One row of the `Setting` table, as the service reads it back. */
export interface SettingRow {
  key: string;
  value: string;
  updatedAt: Date;
}

/** A stand-in `Setting` store with its rows and its recorded writes. */
export interface SettingStoreFixture {
  readonly store: SettingStore;
  readonly rows: Map<string, SettingRow>;
  readonly writes: { key: string; value: string }[];
}

/** Creates a stand-in `Setting` store, optionally seeded with previously accepted values. */
export const createSettingStore = (
  initial: readonly Omit<SettingRow, 'updatedAt'>[] = [],
): SettingStoreFixture => {
  const rows = new Map<string, SettingRow>(
    initial.map((row) => [row.key, { ...row, updatedAt: new Date(0) }]),
  );
  const writes: { key: string; value: string }[] = [];

  const setting = {
    findMany: ({ where }: { where: { key: { in: string[] } } }) =>
      Promise.resolve([...rows.values()].filter((row) => where.key.in.includes(row.key))),
    upsert: ({
      where,
      create,
      update,
    }: {
      where: { key: string };
      create: { key: string; value: string };
      update: { value: string };
    }) => {
      const existing = rows.get(where.key);
      const row = {
        key: where.key,
        value: existing ? update.value : create.value,
        updatedAt: new Date(),
      };

      rows.set(where.key, row);
      writes.push({ key: row.key, value: row.value });

      return Promise.resolve(row);
    },
  };

  return { store: { setting } as unknown as SettingStore, rows, writes };
};

/** The stored value of one `Setting` key, or `undefined` where no row exists. */
export const storedValueOf = (rows: Map<string, SettingRow>, key: string): string | undefined =>
  rows.get(key)?.value;
