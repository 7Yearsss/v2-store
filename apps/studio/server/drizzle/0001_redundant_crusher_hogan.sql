ALTER TABLE "publish_attempts" ADD COLUMN "fields_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "archived_at" timestamp with time zone;