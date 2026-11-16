import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { migrations } from './migrations';
import { openLocalDatabase } from './sqlite';

it('upgrading an existing kiosk database keeps changes still waiting to sync', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kiosk-')), 'kiosk.db');

  // A kiosk that was last updated at schema version 3, with one unsynced change.
  const old = new Database(file);
  for (const m of migrations.filter((m) => m.version <= 3)) old.exec(m.sql);
  old.pragma('user_version = 3');
  old.prepare(`INSERT INTO sync_queue (entity, entity_id, payload) VALUES ('rental', 'r1', '{"x":1}')`).run();
  old.close();

  const db = openLocalDatabase(file);
  expect(db.pragma('user_version', { simple: true })).toBe(migrations.at(-1)!.version);
  expect(db.prepare('SELECT entity, entity_id, payload FROM sync_queue').all()).toEqual([
    { entity: 'rental', entity_id: 'r1', payload: '{"x":1}' },
  ]);
  // ...and the new 'penalty' entity is now allowed.
  db.prepare(`INSERT INTO sync_queue (entity, entity_id, payload) VALUES ('penalty', 'p1', '{}')`).run();
  db.close();
});
