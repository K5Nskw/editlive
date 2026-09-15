import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.ts';
import { createLogger } from '../util/logger.ts';

const log = createLogger('db');
const here = path.dirname(fileURLToPath(import.meta.url));

fs.mkdirSync(config.dataDir, { recursive: true });

export const db = new Database(path.join(config.dataDir, 'editlive.db'));

// The schema ships next to the compiled output; fall back to the source tree in dev.
const schemaPath = [path.join(here, 'schema.sql'), path.join(here, '../../src/db/schema.sql')].find((p) =>
  fs.existsSync(p),
);
if (!schemaPath) throw new Error('schema.sql not found');
db.exec(fs.readFileSync(schemaPath, 'utf8'));
log.info(`sqlite ready at ${path.join(config.dataDir, 'editlive.db')}`);

export function getSetting(key: string): string | undefined {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

export function setSetting(key: string, value: string): void {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    value,
  );
}

export function deleteSetting(key: string): void {
  db.prepare('DELETE FROM settings WHERE key = ?').run(key);
}

export function getJson<T>(key: string): T | undefined {
  const raw = getSetting(key);
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    log.warn(`setting ${key} is not valid JSON, ignoring`);
    return undefined;
  }
}

export function setJson(key: string, value: unknown): void {
  setSetting(key, JSON.stringify(value));
}
