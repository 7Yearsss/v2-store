ALTER TABLE "listing_suggestions" ADD COLUMN "stage" text DEFAULT 'ai' NOT NULL;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "publish_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "remote_variant_map" jsonb;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "source_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "internal_tags" text[];--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "pipeline_stage" text;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "pipeline_hold_reason" text;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "policy_snapshot" jsonb;--> statement-breakpoint
CREATE INDEX "listings_ws_pipeline_idx" ON "listings" USING btree ("workspace_id","pipeline_stage");--> statement-breakpoint
UPDATE "listing_suggestions" SET "stage" = 'categorySuggest' WHERE "field" = 'category' AND "stage" = 'ai';--> statement-breakpoint
UPDATE "listing_suggestions" SET "stage" = 'enhance' WHERE "field" <> 'category' AND "stage" = 'ai';
