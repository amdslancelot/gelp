CREATE TABLE "place_queue" (
	"id" text PRIMARY KEY NOT NULL,
	"maps_url" text NOT NULL,
	"cid" text,
	"title" text,
	"reason" text NOT NULL,
	"requested_by" text,
	"note" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"handled_at" bigint,
	CONSTRAINT "place_queue_maps_url_unique" UNIQUE("maps_url")
);
--> statement-breakpoint
ALTER TABLE "place_queue" ADD CONSTRAINT "place_queue_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "place_queue_status_idx" ON "place_queue" USING btree ("status");