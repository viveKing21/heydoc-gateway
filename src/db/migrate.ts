import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { config } from '../config.js';
import { log } from '../util/log.js';

export interface MigrateOptions {
  databaseUrl?: string;
  dir?: string;
}

/**
 * Forward-only SQL migrations. Each file runs in its own transaction and is
 * recorded in schema_migrations, so a failed migration cannot half-apply.
 */
export async function migrate(options: MigrateOptions = {}): Promise<string[]> {
  const client = new pg.Client({ connectionString: options.databaseUrl ?? config.databaseUrl });
  await client.connect();
  const appliedNow: string[] = [];
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const dir = options.dir ?? path.resolve(process.cwd(), 'migrations');
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    const { rows } = await client.query<{ version: string }>('SELECT version FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.version));

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(path.join(dir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
        await client.query('COMMIT');
        appliedNow.push(file);
        log.info('migration applied', { file });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      }
    }
  } finally {
    await client.end();
  }
  return appliedNow;
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  migrate()
    .then((files) => log.info('migrations complete', { applied: files.length }))
    .catch((err) => {
      log.error('migration failed', { error: (err as Error).message });
      process.exit(1);
    });
}
