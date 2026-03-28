import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

export async function initializeDatabase() {
  const dbPath = process.env.DATABASE_URL || '/app/data/data.db';
  const dbDir = path.dirname(dbPath);

  // Ensure directory exists
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  // Run drizzle-kit push to initialize schema
  try {
    execSync('npm run db:push', { stdio: 'inherit' });
    console.log('Database schema initialized successfully');
  } catch (error) {
    console.error('Failed to initialize database schema:', error);
    throw error;
  }
}
