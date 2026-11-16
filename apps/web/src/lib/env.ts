import { z } from 'zod';

/**
 * PUBLIC environment variables (safe for the browser).
 *
 * Next.js only inlines NEXT_PUBLIC_* values into browser code when they are
 * referenced literally as `process.env.NEXT_PUBLIC_...`, so each one is
 * written out explicitly below — do not "simplify" this into a loop.
 */
const PublicEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z
    .url({ message: 'NEXT_PUBLIC_SUPABASE_URL must be a valid URL' })
    // Keep only "https://<project>.supabase.co". A pasted endpoint such as
    // ".../rest/v1/" would otherwise break the Supabase client's own paths.
    .transform((value) => new URL(value).origin),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z
    .string()
    .min(20, { message: 'NEXT_PUBLIC_SUPABASE_ANON_KEY looks too short' }),
});

export type PublicEnv = z.infer<typeof PublicEnvSchema>;

/** Returns validated public env, or `null` if it is missing/invalid (used by health checks). */
export function readPublicEnv(): PublicEnv | null {
  const parsed = PublicEnvSchema.safeParse({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  });
  return parsed.success ? parsed.data : null;
}

/** Returns validated public env or throws a clear configuration error. */
export function getPublicEnv(): PublicEnv {
  const env = readPublicEnv();
  if (!env) {
    throw new Error(
      'Supabase public environment variables are missing or invalid. ' +
        'Copy apps/web/.env.example to apps/web/.env.local and fill it in.',
    );
  }
  return env;
}
