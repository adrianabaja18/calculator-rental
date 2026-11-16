import 'server-only';
import { z } from 'zod';

/**
 * SERVER-ONLY environment variables.
 *
 * The `server-only` import makes the build FAIL if a Client Component ever
 * imports this file, so the service-role key can never leak to the browser.
 */
const ServerEnvSchema = z.object({
  SUPABASE_SERVICE_ROLE_KEY: z
    .string()
    .min(20, { message: 'SUPABASE_SERVICE_ROLE_KEY looks too short' }),
  APP_URL: z.url().default('http://localhost:3000'),
});

export type ServerEnv = z.infer<typeof ServerEnvSchema>;

export function readServerEnv(): ServerEnv | null {
  const parsed = ServerEnvSchema.safeParse({
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    APP_URL: process.env.APP_URL || undefined,
  });
  return parsed.success ? parsed.data : null;
}

export function getServerEnv(): ServerEnv {
  const env = readServerEnv();
  if (!env) {
    throw new Error(
      'Server environment variables are missing or invalid (SUPABASE_SERVICE_ROLE_KEY, APP_URL). ' +
        'Check apps/web/.env.local.',
    );
  }
  return env;
}
