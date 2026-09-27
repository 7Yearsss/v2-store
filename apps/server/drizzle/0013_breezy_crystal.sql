ALTER TABLE "listing_suggestions" ADD COLUMN "stage" text DEFAULT 'ai' NOT NULL;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "pipeline_stage" text;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "pipeline_hold_reason" text;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "policy_snapshot" jsonb;--> statement-breakpoint
CREATE INDEX "listings_ws_pipeline_idx" ON "listings" USING btree ("workspace_id","pipeline_stage");