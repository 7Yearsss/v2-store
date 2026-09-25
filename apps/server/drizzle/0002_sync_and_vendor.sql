ALTER TABLE "listings" ADD COLUMN "remote_status" text;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "stores" ADD COLUMN "vendor" text DEFAULT '' NOT NULL;