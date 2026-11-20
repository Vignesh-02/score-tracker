CREATE TABLE "cricket_scorecards" (
	"match_id" integer PRIMARY KEY NOT NULL,
	"data" jsonb NOT NULL,
	"final" boolean DEFAULT false NOT NULL,
	"fetched_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cricket_scorecards" ADD CONSTRAINT "cricket_scorecards_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;