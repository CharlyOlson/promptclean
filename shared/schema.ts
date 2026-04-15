import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";
import { z } from "zod";

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export const cleanups = sqliteTable("cleanups", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull(),
  originalPrompt: text("original_prompt").notNull(),
  fixedPrompt: text("fixed_prompt").notNull(),
  totalScore: integer("total_score").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export const insertCleanupSchema = z.object({
  userId: z.string(),
  originalPrompt: z.string(),
  fixedPrompt: z.string(),
  totalScore: z.number().int(),
});
export type InsertCleanup = z.infer<typeof insertCleanupSchema>;
export type Cleanup = typeof cleanups.$inferSelect;

// ── Weighted multi-select types ───────────────────────────────────────────────
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
