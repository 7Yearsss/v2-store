CREATE TABLE "category_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"source_platform" text NOT NULL,
	"source_category_id" text NOT NULL,
	"source_category_name" text,
	"channel" text NOT NULL,
	"channel_category_id" text NOT NULL,
	"channel_category_name" text NOT NULL,
	"version" text DEFAULT '' NOT NULL,
	"confidence" integer DEFAULT 0 NOT NULL,
	"confirmed_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"platform" text NOT NULL,
	"version" text NOT NULL,
	"category_id" text NOT NULL,
	"name" text NOT NULL,
	"path" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"attributes_schema" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "channel_category_id" text;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "channel_category_name" text;--> statement-breakpoint
ALTER TABLE "source_items" ADD COLUMN "source_category_id" text;--> statement-breakpoint
ALTER TABLE "source_items" ADD COLUMN "source_category_name" text;--> statement-breakpoint
ALTER TABLE "category_mappings" ADD CONSTRAINT "category_mappings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "category_mappings_ws_src_channel_uq" ON "category_mappings" USING btree ("workspace_id","source_platform","source_category_id","channel");--> statement-breakpoint
CREATE INDEX "category_mappings_ws_idx" ON "category_mappings" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_categories_platform_version_id_uq" ON "channel_categories" USING btree ("platform","version","category_id");