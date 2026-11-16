/**
 * Project-wide constants shared by the web app and the Raspberry Pi service.
 *
 * Business rules (rental fee, duration, penalties, ...) are NOT defined here.
 * Those live in the `system_settings` database table (Phase 2) so admins can
 * edit them from the dashboard without a code change.
 */

export const APP_NAME = 'Calculator Rental Locker System';

/** Bump when a release is deployed. Reported by /api/health and the Pi heartbeat. */
export const APP_VERSION = '0.1.0';

/** Service identifier returned by the web health check. */
export const WEB_SERVICE_ID = 'calculator-rental-web';

/**
 * All timestamps are STORED in UTC (ISO-8601 / PostgreSQL timestamptz).
 * They are only converted to Philippine time for DISPLAY (dashboard, LCD).
 */
export const DISPLAY_TIME_ZONE = 'Asia/Manila';
export const DISPLAY_LOCALE = 'en-PH';

/** The Pi sends a heartbeat this often (Phase 9/13). */
export const HEARTBEAT_INTERVAL_SECONDS = 30;

/**
 * A kiosk is shown OFFLINE after this many seconds without a heartbeat.
 * Must match the interval in view public.v_device_status.
 */
export const DEVICE_OFFLINE_AFTER_SECONDS = 90;

/** Currency used for rental fees, payments and penalties. */
export const CURRENCY_CODE = 'PHP';
export const CURRENCY_SYMBOL = '₱';
