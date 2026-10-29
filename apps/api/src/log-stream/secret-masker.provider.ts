import type { Provider } from '@nestjs/common';

import { ENV_CONFIG } from '../config/env.config';
import type { EnvConfig } from '../config/env.schema';
import { createSecretMasker, type SecretMasker, secretValuesOf } from './secret-masking';

/** Injection token of the masker every Log_Stream message passes through (14.9). */
export const SECRET_MASKER = Symbol('SECRET_MASKER');

/**
 * Binds the pure masker to the credentials of the running configuration.
 *
 * The factory exists so that {@link createSecretMasker} can stay free of Nest and of
 * `process.env`: the values to mask are read once, here, from the validated configuration that
 * `ConfigModule` provides, and a unit test hands the service its own masker instead.
 *
 * `ENV_CONFIG` rather than `AppConfigService` is the dependency on purpose. The credentials come
 * from the environment file only (14.9) — the `Setting` table holds Home_Address and
 * Commute_Threshold, neither of which is one — so depending on the resolved configuration would
 * add a lifecycle the masker does not need.
 *
 * Requirements: 14.9.
 */
export const secretMaskerProvider: Provider = {
  provide: SECRET_MASKER,
  useFactory: (env: EnvConfig): SecretMasker => createSecretMasker(secretValuesOf(env)),
  inject: [ENV_CONFIG],
};
