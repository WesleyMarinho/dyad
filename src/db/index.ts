// db.ts
import {
  type BetterSQLite3Database,
  drizzle,
} from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import * as schema from "./schema";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "node:path";
import fs from "node:fs";
import { getDyadAppPath, getUserDataPath } from "../paths/paths";
import log from "electron-log";
import crypto from "node:crypto";

const logger = log.scope("db");

// Database connection factory
let _db: ReturnType<typeof drizzle> | null = null;

/**
 * Get the database path based on the current environment
 */
export function getDatabasePath(): string {
  return path.join(getUserDataPath(), "sqlite.db");
}

/**
 * Initialize the database connection
 */
export function initializeDatabase(): BetterSQLite3Database<typeof schema> & {
  $client: Database.Database;
} {
  if (_db) return _db as any;

  const dbPath = getDatabasePath();
  logger.log("Initializing database at:", dbPath);

  // Check if the database file exists and remove it if it has issues
  try {
    if (fs.existsSync(dbPath)) {
      const stats = fs.statSync(dbPath);
      if (stats.size < 100) {
        logger.log("Database file exists but may be corrupted. Removing it...");
        fs.unlinkSync(dbPath);
      }
    }
  } catch (error) {
    logger.error("Error checking database file:", error);
  }

  fs.mkdirSync(getUserDataPath(), { recursive: true });
  fs.mkdirSync(getDyadAppPath("."), { recursive: true });

  const sqlite = new Database(dbPath, { timeout: 10000 });
  sqlite.pragma("foreign_keys = ON");

  _db = drizzle(sqlite, { schema });

  try {
    const migrationsFolder = path.join(__dirname, "..", "..", "drizzle");
    if (!fs.existsSync(migrationsFolder)) {
      logger.error("Migrations folder not found:", migrationsFolder);
    } else {
      backfillMigrationJournal(sqlite, migrationsFolder);
      logger.log("Running migrations from:", migrationsFolder);
      migrate(_db, { migrationsFolder });
    }
  } catch (error) {
    logger.error("Migration error:", error);
  }

  return _db as any;
}

/**
 * Get the database instance (throws if not initialized)
 */
export function getDb(): BetterSQLite3Database<typeof schema> & {
  $client: Database.Database;
} {
  if (!_db) {
    throw new Error(
      "Database not initialized. Call initializeDatabase() first.",
    );
  }
  return _db as any;
}

export const db = new Proxy({} as any, {
  get(target, prop) {
    const database = getDb();
    return database[prop as keyof typeof database];
  },
}) as BetterSQLite3Database<typeof schema> & {
  $client: Database.Database;
};

function backfillMigrationJournal(
  sqlite: Database.Database,
  migrationsFolder: string,
) {
  const journalPath = path.join(migrationsFolder, "meta", "_journal.json");
  const migrationsTable = "__drizzle_migrations";

  try {
    sqlite
      .prepare(
        `CREATE TABLE IF NOT EXISTS "${migrationsTable}" (id INTEGER PRIMARY KEY AUTOINCREMENT, hash text NOT NULL, created_at numeric)`,
      )
      .run();

    const hashRows = sqlite
      .prepare(`SELECT hash FROM "${migrationsTable}"`)
      .all() as { hash: string }[];
    const existingHashes = new Set<string>(hashRows.map((row) => row.hash));

    const hasAppsTable = sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'apps'",
      )
      .get() as { name?: string } | undefined;

    if (!fs.existsSync(journalPath) || (!hasAppsTable && existingHashes.size === 0)) {
      return;
    }

    type JournalEntry = {
      idx: number;
      when: number;
      tag: string;
    };

    const journal = JSON.parse(
      fs.readFileSync(journalPath, "utf8"),
    ) as { entries: JournalEntry[] };

    const insert = sqlite.prepare(
      `INSERT INTO "${migrationsTable}" (hash, created_at) VALUES (?, ?)`,
    );

    let inserted = false;
    for (const entry of journal.entries) {
      const migrationPath = path.join(migrationsFolder, `${entry.tag}.sql`);
      if (!fs.existsSync(migrationPath)) {
        logger.warn(
          `Migration file missing during journal backfill: ${migrationPath}`,
        );
        continue;
      }

      const sqlContent = fs.readFileSync(migrationPath, "utf8");
      const hash = crypto.createHash("sha256").update(sqlContent).digest("hex");

      if (existingHashes.has(hash)) {
        continue;
      }

      insert.run(hash, entry.when);
      existingHashes.add(hash);
      inserted = true;
    }

    if (inserted) {
      logger.log("Backfilled missing entries in __drizzle_migrations.");
    }
  } catch (error) {
    logger.warn("Failed to backfill migration journal:", error);
  }
}
