CREATE TABLE "competition_stats" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"area" text,
	"emblem" text,
	"season" jsonb,
	"standings" jsonb NOT NULL,
	"scorers" jsonb NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
