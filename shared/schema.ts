import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const cleanups = sqliteTable("cleanups", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  originalPrompt: text("original_prompt").notNull(),
  fixedPrompt: text("fixed_prompt").notNull(),
  totalScore: integer("total_score").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export const insertCleanupSchema = createInsertSchema(cleanups).omit({ id: true, createdAt: true });
export type InsertCleanup = z.infer<typeof insertCleanupSchema>;
export type Cleanup = typeof cleanups.$inferSelect;

// ── Weighted multi-select types ───────────────────────────────────────────────
export type OptionId = string;

export interface Option {
  id: OptionId;        // "A", "B", "C", "D"
  label: string;       // "A.", "B.", etc.
  text: string;        // the option text shown to the user
  selected: boolean;
  weight: number;      // 0–100, only meaningful if selected
  isCustom?: boolean;  // true for the "type your own" option
}

/** Serialisable snapshot of a weighted multi-select answer */
export interface WeightedAnswer {
  questionId: string;
  selections: { optionId: OptionId; text: string; weight: number }[];
  customText?: string; // populated when the user typed a custom option
}
