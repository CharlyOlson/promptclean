import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";
import { z } from "zod";

// ── Users ──────────────────────────────────────────────────────────────────────
export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

// ── Cleanups ───────────────────────────────────────────────────────────────────
export const cleanups = sqliteTable("cleanups", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull(),
  originalPrompt: text("original_prompt").notNull(),
  fixedPrompt: text("fixed_prompt").notNull(),
  totalScore: integer("total_score").notNull(),
  // Nuance tracking
  failureCategory: text("failure_category"),   // Alpha's diagnosis e.g. "vague category"
  patternTag: text("pattern_tag"),             // 2-3 word tag e.g. "missing audience"
  scoreJson: text("score_json"),               // JSON: {specificity,context,constraints,outputDef}
  // Media
  hasImageInput: integer("has_image_input", { mode: "boolean" }).default(false),
  hasVideoInput: integer("has_video_input", { mode: "boolean" }).default(false),
  generatedImageUrl: text("generated_image_url"), // base64 data URL of generated image
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

// ── Nuance profiles — one row per session, updated on each cleanup ─────────────
export const nuanceProfiles = sqliteTable("nuance_profiles", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull().unique(),
  // JSON array of { tag: string, count: number } — top personal patterns
  personalPatternsJson: text("personal_patterns_json").notNull().default("[]"),
  totalRuns: integer("total_runs").notNull().default(0),
  avgScore: integer("avg_score").notNull().default(0),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

// ── Community baseline — single row, updated after each cleanup ────────────────
export const communityBaseline = sqliteTable("community_baseline", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // JSON array of { tag: string, count: number, pct: number } — top patterns across all users
  topPatternsJson: text("top_patterns_json").notNull().default("[]"),
  totalCleanups: integer("total_cleanups").notNull().default(0),
  avgScore: integer("avg_score").notNull().default(0),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

// ── Zod schemas ────────────────────────────────────────────────────────────────
export const insertCleanupSchema = z.object({
  userId: z.string(),
  originalPrompt: z.string(),
  fixedPrompt: z.string(),
  totalScore: z.number().int(),
  failureCategory: z.string().optional(),
  patternTag: z.string().optional(),
  scoreJson: z.string().optional(),
  hasImageInput: z.boolean().optional(),
  hasVideoInput: z.boolean().optional(),
  generatedImageUrl: z.string().optional(),
});

export type InsertCleanup = z.infer<typeof insertCleanupSchema>;
export type Cleanup = typeof cleanups.$inferSelect;
export type NuanceProfile = typeof nuanceProfiles.$inferSelect;
export type CommunityBaseline = typeof communityBaseline.$inferSelect;

// ── Weighted multi-select types (kept from Railway version) ───────────────────
export type OptionId = string;
export interface Option {
  id: OptionId;
  label: string;
  text: string;
  selected: boolean;
  weight: number;
  isCustom?: boolean;
}
export interface WeightedAnswer {
  questionId: string;
  selections: { optionId: OptionId; text: string; weight: number }[];
  customText?: string;
}
