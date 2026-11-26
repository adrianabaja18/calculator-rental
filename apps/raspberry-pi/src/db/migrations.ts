import { SQLITE_MIGRATIONS, SQL_UTC_NOW, type SqliteMigration } from '@calc-rental/shared';

export type Migration = SqliteMigration;
export { SQL_UTC_NOW };
export const migrations: readonly Migration[] = SQLITE_MIGRATIONS;
