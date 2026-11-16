/**
 * Rental business rules — pure functions with no I/O.
 * Under SQLite-first the kiosk runs them against its local database;
 * the server can run the same code to re-validate synced records.
 */
export * from './result';
export * from './eligibility';
export * from './availability';
export * from './lifecycle';
export * from './transaction-code';
export * from './settings';
export * from './penalty';
