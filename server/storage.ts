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
  CREATE TABLE IF NOT EXISTS cleanups (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         TEXT    NOT NULL,
    original_prompt TEXT    NOT NULL,
    fixed_prompt    TEXT    NOT NULL,
    total_score     INTEGER NOT NULL,
    created_at      INTEGER NOT NULL
  )
`);

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
