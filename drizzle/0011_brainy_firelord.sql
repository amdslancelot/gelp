ALTER TABLE "place_queue" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "place_queue" ADD COLUMN "last_error" text;