import dotenv from 'dotenv';
import { z } from 'zod';

/**
 * Loads apps/raspberry-pi/.env and validates it ONCE at startup.
 * If anything is wrong the process stops immediately with a clear message,
 * instead of failing later in the middle of a rental.
 */
dotenv.config({ quiet: true });

const booleanString = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const ConfigSchema = z.object({
  BACKEND_URL: z.url({ message: 'BACKEND_URL must be a full URL, e.g. http://localhost:3000' }),
  DEVICE_ID: z
    .string()
    .regex(/^DEVICE-[A-Z0-9-]+$/, { message: 'DEVICE_ID must look like DEVICE-CALC-KIOSK-001' }),
  DEVICE_SECRET: z.string().min(16, { message: 'DEVICE_SECRET must be at least 16 characters' }),
  SQLITE_PATH: z.string().min(1).default('./data/kiosk.db'),
  HARDWARE_MODE: z.enum(['mock', 'real']).default('mock'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  LOG_PRETTY: booleanString,
  HTTP_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(8000),
});

export type PiConfig = z.infer<typeof ConfigSchema>;

function loadConfig(): PiConfig {
  const parsed = ConfigSchema.safeParse(process.env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    // Logger is not available yet (it depends on config), so print directly.
    console.error(
      `\n[config] Invalid Raspberry Pi configuration:\n${problems}\n\n` +
        'Copy apps/raspberry-pi/.env.example to apps/raspberry-pi/.env and fix the values above.\n',
    );
    process.exit(1);
  }
  return parsed.data;
}

export const config: PiConfig = loadConfig();
