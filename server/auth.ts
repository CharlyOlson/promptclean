/**
 * auth.ts
 *
 * Simple username/password authentication backed by the SQLite database.
 * Passwords are hashed with scrypt (Node built-in crypto).
 * Registers /api/auth/* routes on the Express app.
 */

import type { Express } from "express";
import { db } from "./storage";
import { users } from "@shared/schema";
import { eq } from "drizzle-orm";
import crypto from "crypto";

// ── Password hashing helpers ────────────────────────────────────────────────

function hashPassword(password: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16).toString("hex");
    crypto.scrypt(password, salt, 64, (err, derivedKey) => {
      if (err) reject(err);
      resolve(`${salt}:${derivedKey.toString("hex")}`);
    });
  });
}

function verifyPassword(password: string, stored: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const [salt, key] = stored.split(":");
    crypto.scrypt(password, salt, 64, (err, derivedKey) => {
      if (err) reject(err);
      resolve(derivedKey.toString("hex") === key);
    });
  });
}

// ── Route registration ──────────────────────────────────────────────────────

export function registerAuthRoutes(app: Express) {
  // Register
  app.post("/api/auth/register", async (req, res) => {
    const { username, password } = req.body ?? {};

    if (
      !username ||
      !password ||
      typeof username !== "string" ||
      typeof password !== "string"
    ) {
      return res.status(400).json({ message: "Username and password are required" });
    }

    if (username.length < 3 || username.length > 30) {
      return res.status(400).json({ message: "Username must be between 3 and 30 characters" });
    }

    if (password.length < 4) {
      return res.status(400).json({ message: "Password must be at least 4 characters" });
    }

    // Only allow alphanumeric + underscore
    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
      return res.status(400).json({ message: "Username can only contain letters, numbers, and underscores" });
    }

    try {
      const existing = db
        .select()
        .from(users)
        .where(eq(users.username, username))
        .get();

      if (existing) {
        return res.status(409).json({ message: "Username already taken" });
      }

      const hashed = await hashPassword(password);
      const user = db
        .insert(users)
        .values({ username, password: hashed })
        .returning()
        .get();

      // Set session
      req.session.userId = String(user.id);
      req.session.authUsername = username;

      return res.json({ id: user.id, username: user.username });
    } catch (error: any) {
      console.error("Register error:", error);
      return res.status(500).json({ message: "Registration failed" });
    }
  });

  // Login
  app.post("/api/auth/login", async (req, res) => {
    const { username, password } = req.body ?? {};

    if (
      !username ||
      !password ||
      typeof username !== "string" ||
      typeof password !== "string"
    ) {
      return res.status(400).json({ message: "Username and password are required" });
    }

    try {
      const user = db
        .select()
        .from(users)
        .where(eq(users.username, username))
        .get();

      if (!user) {
        return res.status(401).json({ message: "Invalid username or password" });
      }

      const valid = await verifyPassword(password, user.password);
      if (!valid) {
        return res.status(401).json({ message: "Invalid username or password" });
      }

      // Set session
      req.session.userId = String(user.id);
      req.session.authUsername = username;

      return res.json({ id: user.id, username: user.username });
    } catch (error: any) {
      console.error("Login error:", error);
      return res.status(500).json({ message: "Login failed" });
    }
  });

  // Get current user
  app.get("/api/auth/me", (req, res) => {
    if (!req.session.authUsername) {
      return res.status(401).json({ message: "Not authenticated" });
    }
    return res.json({
      id: req.session.userId,
      username: req.session.authUsername,
    });
  });

  // Logout
  app.post("/api/auth/logout", (req, res) => {
    req.session.destroy((err) => {
      if (err) {
        console.error("Logout error:", err);
        return res.status(500).json({ message: "Logout failed" });
      }
      res.clearCookie("connect.sid");
      return res.json({ ok: true });
    });
  });
}
