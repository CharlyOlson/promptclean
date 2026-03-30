import { type Cleanup, type InsertCleanup, cleanups } from "@shared/schema";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { desc } from "drizzle-orm";
import fs from "fs";
import path from "path";

const dbUrl = process.env.DATABASE_URL ?? "/app/data/data.db";

// Ensure the directory exists before opening the database. The volume is
// mounted before the app process starts, so this runs after the mount and
// guarantees the schema is created on the persistent volume.
const dbDir = path.dirname(dbUrl);
fs.mkdirSync(dbDir, { recursive: true });

const sqlite = new Database(dbUrl);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

export const db = drizzle(sqlite);

// ─── Schema ownership ────────────────────────────────────────────────────────
// storage.ts is the single source of truth for schema creation.
// Drizzle migration files (./migrations) are NOT used at runtime; drizzle-kit
// is kept only as a dev tool for inspecting or generating one-off SQL.
// Table creation uses CREATE TABLE IF NOT EXISTS so every deploy is idempotent.
// To evolve the schema, add a new ALTER TABLE … statement below this block.
// ─────────────────────────────────────────────────────────────────────────────
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS cleanups (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    original_prompt TEXT    NOT NULL,
    fixed_prompt    TEXT    NOT NULL,
    total_score     INTEGER NOT NULL,
    created_at      INTEGER NOT NULL
  )
`);

export interface IStorage {
  createCleanup(cleanup: InsertCleanup): Promise<Cleanup>;
  getRecentCleanups(limit: number): Promise<Cleanup[]>;
}

export class DatabaseStorage implements IStorage {
  async createCleanup(data: InsertCleanup): Promise<Cleanup> {
    return db.insert(cleanups).values(data).returning().get();
  }

  async getRecentCleanups(limit: number): Promise<Cleanup[]> {
    return db.select().from(cleanups).orderBy(desc(cleanups.createdAt)).limit(limit).all();
  }
}

export const storage = new DatabaseStorage();
