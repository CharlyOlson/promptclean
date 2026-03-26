import express, { type Express } from "express";
import fs from "fs";
import path from "path";

export function serveStatic(app: Express) {
  const entryFile = process.argv[1];
  const entryDir =
    entryFile && path.isAbsolute(entryFile)
      ? path.dirname(entryFile)
      : process.cwd();

  const candidatePaths = [
    // Relative to the entrypoint directory
    path.resolve(entryDir, "dist", "public"),
    path.resolve(entryDir, "public"),
    // Relative to the current working directory (for backward compatibility)
    path.resolve(process.cwd(), "dist", "public"),
    path.resolve(process.cwd(), "public"),
  ];

  const distPath = candidatePaths.find((p) => fs.existsSync(p));

  if (!distPath) {
    throw new Error(
      `Could not find the build directory. Tried: ${candidatePaths.join(
        ", ",
      )}. Make sure to build the client first.`,
    );
  }

  // Serve built assets
  app.use(express.static(distPath));

  // Fallback to index.html for any other GET route (SPA routing)
  app.get("/{*path}", (_req, res) => {
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}
