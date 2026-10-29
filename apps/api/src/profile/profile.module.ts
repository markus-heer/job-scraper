import { Module } from '@nestjs/common';

import { DefaultProfileService } from './profile.service';

/**
 * The Default_Search_Profile check at startup (3.5, 3.6).
 *
 * The module exists so that the check participates in the application lifecycle. It has no
 * dependencies on purpose: the profile is a TypeScript constant, not data, so the check needs
 * neither the Posting_Store nor the environment file and can run no matter what else fails.
 */
@Module({
  providers: [DefaultProfileService],
  exports: [DefaultProfileService],
})
export class ProfileModule {}
