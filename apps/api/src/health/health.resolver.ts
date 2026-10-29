import { Query, Resolver } from '@nestjs/graphql';

/**
 * The single value the `health` query answers with. The Start_Script polls the query in step 6 to
 * confirm that the API_Service is ready before it serves the Web_App in step 7 (1.1), so the value
 * is a constant the script can compare against rather than a free-form message.
 */
export const HEALTH_OK = 'ok';

/**
 * Liveness of the API_Service.
 *
 * There is no service behind this resolver on purpose: the query carries no business logic, it only
 * proves that the process is up, that the GraphQL layer is mounted and that the schema was built.
 * Readiness checks with a real subject — the configuration validation of task 5.2, the
 * Posting_Store connection of 5.3 — are separate concerns and arrive with those tasks.
 */
@Resolver()
export class HealthResolver {
  @Query(() => String, {
    name: 'health',
    description:
      "Liveness probe. Answers with 'ok' as soon as the API_Service serves GraphQL requests.",
  })
  health(): string {
    return HEALTH_OK;
  }
}
