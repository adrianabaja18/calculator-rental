import pino from 'pino';
import { config } from './config';

/**
 * Structured logger. Every line contains: timestamp, level, device, message,
 * plus optional fields such as `event` and `transactionId`.
 *
 *   logger.info({ event: 'QR_SCANNED', transactionId }, 'Student ID scanned');
 *
 * LOG_PRETTY=true  -> readable coloured output for development.
 * LOG_PRETTY=false -> one JSON object per line (production / journald).
 */
export const logger = pino({
  level: config.LOG_LEVEL,
  messageKey: 'message',
  base: { device: config.DEVICE_ID },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
  },
  ...(config.LOG_PRETTY
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            messageKey: 'message',
            translateTime: 'SYS:yyyy-mm-dd HH:MM:ss',
            ignore: 'pid,hostname',
          },
        },
      }
    : {}),
});

export type Logger = typeof logger;
