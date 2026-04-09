import { type Cleanup, type InsertCleanup, cleanups } from "@shared/schema";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { desc, eq } from "drizzle-orm";
import fs from "fs";
import path from "path";

const dbUrl = process.env.DATABASE_URL ?? "data.db";

const dbDir = path.dirname(dbUrl);
fs.mkdirSync(dbDir, { recursive: true });

const sqlite = new Database(dbUrl);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

export const db = drizzle(sqlite);

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    username        TEXT    NOT NULL UNIQUE,
    password        TEXT    NOT NULL,
    created_at      INTEGER NOT NULL DEFAULT (unixepoch())
  )
`);

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS cleanups (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         TEXT    NOT NULL,
    original_prompt TEXT    NOT NULL,
    fixed_prompt    TEXT    NOT NULL,
    total_score     INTEGER NOT NULL,
    created_at      INTEGER NOT NULL
  )
`);

// ── Schema migration: add columns that may be missing from older databases ────
// SQLite does not support IF NOT EXISTS on ALTER TABLE, so we inspect
// PRAGMA table_info and only issue the ALTER when the column is absent.
(function migrateSchema() {
  type ColumnInfo = { name: string };
  const columns = sqlite
    .prepare("PRAGMA table_info(cleanups)")
    .all() as ColumnInfo[];
  const columnNames = new Set(columns.map((c) => c.name));

  function addColumnIfMissing(
    columnName: string,
    logMessage: string,
    sql: string,
  ) {
    if (columnNames.has(columnName)) {
      return;
    }

    console.log(logMessage);

    try {
      sqlite.exec(sql);
      columnNames.add(columnName);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("duplicate column name")
      ) {
        columnNames.add(columnName);
        return;
      }

      throw error;
    }
  }

  addColumnIfMissing(
    "user_id",
    "[db] Migrating cleanups table: adding user_id column (existing rows → 'anonymous')",
    "ALTER TABLE cleanups ADD COLUMN user_id TEXT NOT NULL DEFAULT 'anonymous'",
  );

  addColumnIfMissing(
    "created_at",
    "[db] Migrating cleanups table: adding created_at column (existing rows → 0)",
    "ALTER TABLE cleanups ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0",
  );
})();

export interface IStorage {
  createCleanup(cleanup: InsertCleanup): Promise<Cleanup>;
  getRecentCleanups(userId: string, limit: number): Promise<Cleanup[]>;
}

export class DatabaseStorage implements IStorage {
  async createCleanup(data: InsertCleanup): Promise<Cleanup> {
    return db.insert(cleanups).values(data).returning().get();
  }

  async getRecentCleanups(userId: string, limit: number): Promise<Cleanup[]> {
    return db
      .select()
      .from(cleanups)
      .where(eq(cleanups.userId, userId))
      .orderBy(desc(cleanups.createdAt))
      .limit(limit)
      .all();
  }
}

export const storage = new DatabaseStorage();
