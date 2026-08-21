ALTER TABLE "users" ADD COLUMN "drive_sync_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "drive_refresh_token_enc" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "drive_folder_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "drive_folder_name" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "drive_last_synced_at" bigint;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "drive_last_error" text;