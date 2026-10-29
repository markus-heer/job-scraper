import { Module } from '@nestjs/common';

import { HealthResolver } from './health.resolver';

/** Feature module of the `health` query. */
@Module({
  providers: [HealthResolver],
})
export class HealthModule {}
