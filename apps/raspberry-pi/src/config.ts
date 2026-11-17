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

const booleanTrue = z
  .enum(['true', 'false'])
  .default('true')
  .transform((value) => value === 'true');

const ConfigSchema = z.object({
  BACKEND_URL: z.url({ message: 'BACKEND_URL must be a full URL, e.g. http://localhost:3000' }),
  DEVICE_ID: z
    .string()
    .regex(/^DEVICE-[A-Z0-9-]+$/, { message: 'DEVICE_ID must look like DEVICE-CALC-KIOSK-001' }),
  DEVICE_SECRET: z.string().min(16, { message: 'DEVICE_SECRET must be at least 16 characters' }),
  SQLITE_PATH: z.string().min(1).default('./data/kiosk.db'),
  HARDWARE_MODE: z.enum(['mock', 'real']).default('mock'),
  /** mock = keyboard console; serial = ESP32-CAM on SCANNER_PORT (Phase 10). */
  QR_SCANNER: z.enum(['mock', 'serial']).default('mock'),
  SCANNER_PORT: z.string().min(1).default('/dev/ttyUSB0'),
  // ---- Real hardware (HARDWARE_MODE=real, Phase 11). Pins are BCM numbers. ----
  PYTHON_BIN: z.string().min(1).default(process.platform === 'win32' ? 'python' : 'python3'),
  RELAY_PINS: z.string().regex(/^d+(,d+)*$/).default('5,6'),
  RELAY_ACTIVE_LOW: booleanTrue,
  LOCK_PULSE_MS: z.coerce.number().int().min(500).max(10_000).default(3000),
  COIN_PIN: z.coerce.number().int().min(0).max(27).default(17),
  COIN_PULSE_GAP_MS: z.coerce.number().int().min(50).max(1000).default(200),
  BUZZER_PIN: z.coerce.number().int().min(0).max(27).default(18),
  BUZZER_ACTIVE_LOW: booleanString,
  RFID_SPI: z.string().regex(/^d.d(,d.d)*$/).default('0.0,0.1'),
  I2C_BUS: z.coerce.number().int().min(0).max(10).default(1),
  LCD_I2C_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{2}$/).default('0x27'),
  DOOR_PINS: z.string().regex(/^(d+(,d+)*)?$/).default(''),
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

/** Command-line arguments for hw-bridge/hw_bridge.py built from the .env settings. */
export function bridgeArgs(c: PiConfig, options: { mock?: boolean } = {}): string[] {
  return [
    ...(options.mock ? ['--mock'] : []),
    '--relay-pins', c.RELAY_PINS,
    ...(c.RELAY_ACTIVE_LOW ? [] : ['--relay-active-high']),
    '--coin-pin', String(c.COIN_PIN),
    '--coin-gap-ms', String(c.COIN_PULSE_GAP_MS),
    '--buzzer-pin', String(c.BUZZER_PIN),
    ...(c.BUZZER_ACTIVE_LOW ? ['--buzzer-active-low'] : []),
    '--rfid', c.RFID_SPI,
    '--i2c-bus', String(c.I2C_BUS),
    '--lcd-address', c.LCD_I2C_ADDRESS,
    ...(c.DOOR_PINS ? ['--door-pins', c.DOOR_PINS] : []),
  ];
}
