ALTER TABLE "matches" ADD COLUMN "competition" text;--> statement-breakpoint
ALTER TABLE "matches" ADD COLUMN "source" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "matches" ADD COLUMN "external_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "matches_source_external_id_idx" ON "matches" USING btree ("source","external_id");