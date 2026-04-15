import {
  type Cleanup,
  type InsertCleanup,
  type NuanceProfile,
  type CommunityBaseline,
  cleanups,
  nuanceProfiles,
  communityBaseline,
} from "@shared/schema";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { desc, eq, sql } from "drizzle-orm";
import fs from "fs";
import path from "path";

const dbUrl = process.env.DATABASE_URL ?? "data.db";
const dbDir = path.dirname(dbUrl);
fs.mkdirSync(dbDir, { recursive: true });

const sqlite = new Database(dbUrl);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

export const db = drizzle(sqlite);

// ── Schema bootstrap ───────────────────────────────────────────────────────────
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    username   TEXT    NOT NULL UNIQUE,
    password   TEXT    NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )
`);

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS cleanups (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id             TEXT    NOT NULL DEFAULT 'anonymous',
    original_prompt     TEXT    NOT NULL,
    fixed_prompt        TEXT    NOT NULL,
    total_score         INTEGER NOT NULL,
    failure_category    TEXT,
    pattern_tag         TEXT,
    score_json          TEXT,
    has_image_input     INTEGER DEFAULT 0,
    has_video_input     INTEGER DEFAULT 0,
    generated_image_url TEXT,
    created_at          INTEGER NOT NULL DEFAULT (unixepoch())
  )
`);

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS nuance_profiles (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id               TEXT    NOT NULL UNIQUE,
    personal_patterns_json TEXT   NOT NULL DEFAULT '[]',
    total_runs            INTEGER NOT NULL DEFAULT 0,
    avg_score             INTEGER NOT NULL DEFAULT 0,
    updated_at            INTEGER NOT NULL DEFAULT (unixepoch())
  )
`);

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS community_baseline (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    top_patterns_json TEXT    NOT NULL DEFAULT '[]',
    total_cleanups    INTEGER NOT NULL DEFAULT 0,
    avg_score         INTEGER NOT NULL DEFAULT 0,
    updated_at        INTEGER NOT NULL DEFAULT (unixepoch())
  )
`);

// ── Migrations: add columns that may be missing from older DBs ─────────────────
(function migrate() {
  type Col = { name: string };
  const cols = new Set(
    (sqlite.prepare("PRAGMA table_info(cleanups)").all() as Col[]).map((c) => c.name)
  );
  const add = (col: string, sql: string) => {
    if (!cols.has(col)) {
      try { sqlite.exec(sql); cols.add(col); }
      catch (e: any) { if (!e.message.includes("duplicate column")) throw e; }
    }
  };
  add("user_id",             "ALTER TABLE cleanups ADD COLUMN user_id TEXT NOT NULL DEFAULT 'anonymous'");
  add("failure_category",    "ALTER TABLE cleanups ADD COLUMN failure_category TEXT");
  add("pattern_tag",         "ALTER TABLE cleanups ADD COLUMN pattern_tag TEXT");
  add("score_json",          "ALTER TABLE cleanups ADD COLUMN score_json TEXT");
  add("has_image_input",     "ALTER TABLE cleanups ADD COLUMN has_image_input INTEGER DEFAULT 0");
  add("has_video_input",     "ALTER TABLE cleanups ADD COLUMN has_video_input INTEGER DEFAULT 0");
  add("generated_image_url", "ALTER TABLE cleanups ADD COLUMN generated_image_url TEXT");
})();

// Seed community_baseline row if empty
const baselineCount = (sqlite.prepare("SELECT COUNT(*) as c FROM community_baseline").get() as any).c;
if (baselineCount === 0) {
  sqlite.exec("INSERT INTO community_baseline (top_patterns_json, total_cleanups, avg_score) VALUES ('[]', 0, 0)");
}

// ── Storage interface ──────────────────────────────────────────────────────────
export interface IStorage {
  createCleanup(data: InsertCleanup): Promise<Cleanup>;
  getRecentCleanups(userId: string, limit: number): Promise<Cleanup[]>;
  getNuanceProfile(userId: string): Promise<NuanceProfile | null>;
  upsertNuanceProfile(userId: string, patternTag: string, score: number): Promise<void>;
  getCommunityBaseline(): Promise<CommunityBaseline | null>;
  refreshCommunityBaseline(): Promise<void>;
  getUserCleanupHistory(userId: string): Promise<Cleanup[]>;
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

  async getUserCleanupHistory(userId: string): Promise<Cleanup[]> {
    return db
      .select()
      .from(cleanups)
      .where(eq(cleanups.userId, userId))
      .orderBy(desc(cleanups.createdAt))
      .all();
  }

  async getNuanceProfile(userId: string): Promise<NuanceProfile | null> {
    return db
      .select()
      .from(nuanceProfiles)
      .where(eq(nuanceProfiles.userId, userId))
      .get() ?? null;
  }

  async upsertNuanceProfile(userId: string, patternTag: string, score: number): Promise<void> {
    const existing = await this.getNuanceProfile(userId);
    if (!existing) {
      const patterns = patternTag ? [{ tag: patternTag, count: 1 }] : [];
      db.insert(nuanceProfiles).values({
        userId,
        personalPatternsJson: JSON.stringify(patterns),
        totalRuns: 1,
        avgScore: score,
        updatedAt: new Date(),
      }).run();
    } else {
      // Update pattern counts
      const patterns: { tag: string; count: number }[] =
        JSON.parse(existing.personalPatternsJson || "[]");

      if (patternTag) {
        const existing_pattern = patterns.find((p) => p.tag === patternTag);
        if (existing_pattern) {
          existing_pattern.count++;
        } else {
          patterns.push({ tag: patternTag, count: 1 });
        }
        patterns.sort((a, b) => b.count - a.count);
      }

      const newTotal = existing.totalRuns + 1;
      const newAvg = Math.round((existing.avgScore * existing.totalRuns + score) / newTotal);

      db.update(nuanceProfiles)
        .set({
          personalPatternsJson: JSON.stringify(patterns.slice(0, 10)), // top 10
          totalRuns: newTotal,
          avgScore: newAvg,
          updatedAt: new Date(),
        })
        .where(eq(nuanceProfiles.userId, userId))
        .run();
    }
  }

  async getCommunityBaseline(): Promise<CommunityBaseline | null> {
    return db.select().from(communityBaseline).get() ?? null;
  }

  async refreshCommunityBaseline(): Promise<void> {
    // Aggregate all pattern_tag counts across all users
    const rows = sqlite.prepare(
      "SELECT pattern_tag, COUNT(*) as cnt FROM cleanups WHERE pattern_tag IS NOT NULL GROUP BY pattern_tag ORDER BY cnt DESC LIMIT 10"
    ).all() as { pattern_tag: string; cnt: number }[];

    const total = (sqlite.prepare("SELECT COUNT(*) as c FROM cleanups").get() as any).c;
    const avgRow = (sqlite.prepare("SELECT AVG(total_score) as a FROM cleanups").get() as any);
    const avg = Math.round(avgRow?.a ?? 0);

    const topPatterns = rows.map((r) => ({
      tag: r.pattern_tag,
      count: r.cnt,
      pct: total > 0 ? Math.round((r.cnt / total) * 100) : 0,
    }));

    db.update(communityBaseline)
      .set({
        topPatternsJson: JSON.stringify(topPatterns),
        totalCleanups: total,
        avgScore: avg,
        updatedAt: new Date(),
      })
      .run();
  }
}

export const storage = new DatabaseStorage();
