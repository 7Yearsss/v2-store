CREATE TABLE "freight_forwarders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"receiver" text,
	"phone" text,
	"country" text,
	"province" text,
	"city" text,
	"address" text,
	"zipcode" text,
	"system_type" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"source_item_id" uuid NOT NULL,
	"change_type" text NOT NULL,
	"sku_id" text,
	"old_value" jsonb,
	"new_value" jsonb,
	"fingerprint" text NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone,
	"applied_action" jsonb
);
--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "source_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "internal_tags" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "publish_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "source_items" ADD COLUMN "availability" text DEFAULT 'ok' NOT NULL;--> statement-breakpoint
ALTER TABLE "source_items" ADD COLUMN "delisted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "source_items" ADD COLUMN "last_scanned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "source_items" ADD COLUMN "collected_via" text;--> statement-breakpoint
ALTER TABLE "freight_forwarders" ADD CONSTRAINT "freight_forwarders_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_changes" ADD CONSTRAINT "source_changes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_changes" ADD CONSTRAINT "source_changes_source_item_id_source_items_id_fk" FOREIGN KEY ("source_item_id") REFERENCES "public"."source_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "freight_forwarders_ws_idx" ON "freight_forwarders" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "source_changes_ws_item_detected_idx" ON "source_changes" USING btree ("workspace_id","source_item_id","detected_at");--> statement-breakpoint
CREATE INDEX "source_changes_pending_idx" ON "source_changes" USING btree ("workspace_id","source_item_id") WHERE "source_changes"."applied_at" is null;--> statement-breakpoint
CREATE INDEX "listings_ws_source_changed_idx" ON "listings" USING btree ("workspace_id","source_changed_at");