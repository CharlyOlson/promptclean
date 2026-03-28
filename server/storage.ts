import { type Cleanup, type InsertCleanup, cleanups } from "@shared/schema";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { desc, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

const sqlite = new Database(process.env.DATABASE_URL ?? "data.db");
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

export const db = drizzle(sqlite);

// Run Drizzle migrations on startup to ensure the database schema matches
// the table definitions in @shared/schema (e.g., cleanups).
migrate(db, { migrationsFolder: "drizzle" });

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
