import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "fs";
import path from "path";
import { db } from "./storage";

export async function initializeDatabase() {
  // Use the same default as elsewhere in the codebase:
  // DATABASE_URL or "data.db" if it is unset.
  const effectiveDbUrl = process.env.DATABASE_URL ?? "data.db";
  let dbPath: string;

  if (effectiveDbUrl.startsWith("file:")) {
    // Normalize file: URIs (e.g., file:/app/data/data.db) to a filesystem path
    try {
      dbPath = new URL(effectiveDbUrl).pathname;
    } catch {
      // Fallback: use the raw value if URL parsing fails
      dbPath = effectiveDbUrl;
    }
  } else {
    dbPath = effectiveDbUrl;
  }
  const dbDir = path.dirname(dbPath);

  // Ensure directory exists (recursive: true is a no-op if it already exists)
  await fs.promises.mkdir(dbDir, { recursive: true });

  // Apply migrations using drizzle-orm's in-process migrator — no drizzle-kit CLI needed at runtime
  const migrationsFolder = path.resolve(process.cwd(), "migrations");
  try {
    migrate(db, { migrationsFolder });
    console.log("Database schema initialized successfully");
  } catch (error) {
    console.error("Failed to apply database migrations:", error);
    throw error;
  }
}
