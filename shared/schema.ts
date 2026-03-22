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
