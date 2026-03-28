import { execSync } from "child_process";
import fs from "fs";
import path from "path";

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

  // Ensure directory exists
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const isProduction = process.env.NODE_ENV === 'production';

  if (!isProduction) {
    // Run drizzle-kit push to initialize schema in non-production environments
    try {
      execSync('npm run db:push', { stdio: 'inherit' });
      console.log('Database schema initialized successfully');
    } catch (error) {
      console.error('Failed to initialize database schema:', error);
      throw error;
    }
  } else {
    // In production, assume schema has been migrated during build/deploy
    console.log('Skipping runtime database schema initialization in production environment');
  }
}
