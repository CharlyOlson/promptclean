import { execSync } from "child_process";
import fs from "fs";
import path from "path";

export async function initializeDatabase() {
  const rawDbUrl = process.env.DATABASE_URL;
  let dbPath: string;

  if (!rawDbUrl) {
    // Match the default used elsewhere in the codebase
    dbPath = 'data.db';
  } else if (rawDbUrl.startsWith('file:')) {
    // Normalize file: URIs (e.g., file:/app/data/data.db) to a filesystem path
    try {
      dbPath = new URL(rawDbUrl).pathname;
    } catch {
      // Fallback: use the raw value if URL parsing fails
      dbPath = rawDbUrl;
    }
  } else {
    dbPath = rawDbUrl;
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
