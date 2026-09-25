CREATE TABLE "attribute_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"source_name" text NOT NULL,
	"channel_attr_id" text NOT NULL,
	"channel_attr_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "channel_categories" ALTER COLUMN "attributes_schema" SET DEFAULT '{"attributes":[]}'::jsonb;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "channel_attributes" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "attribute_mappings" ADD CONSTRAINT "attribute_mappings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attribute_mappings_ws_channel_source_uq" ON "attribute_mappings" USING btree ("workspace_id","channel","source_name");