CREATE TABLE `cleanups` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`original_prompt` text NOT NULL,
	`fixed_prompt` text NOT NULL,
	`total_score` integer NOT NULL,
	`created_at` integer NOT NULL
);
