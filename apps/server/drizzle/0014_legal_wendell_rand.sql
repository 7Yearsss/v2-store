CREATE TABLE "discovery_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"plan_id" uuid,
	"source_platform" text DEFAULT '1688' NOT NULL,
	"source_item_id" text NOT NULL,
	"title" text,
	"price_text" text,
	"thumb" text,
	"signals" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"score" real,
	"ai_note" text,
	"status" text DEFAULT 'new' NOT NULL,
	"source_item_db_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "selection_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"source" text DEFAULT 'keyword' NOT NULL,
	"filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"schedule" text DEFAULT 'manual' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "discovery_items" ADD CONSTRAINT "discovery_items_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_items" ADD CONSTRAINT "discovery_items_plan_id_selection_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."selection_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_items" ADD CONSTRAINT "discovery_items_source_item_db_id_source_items_id_fk" FOREIGN KEY ("source_item_db_id") REFERENCES "public"."source_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "selection_plans" ADD CONSTRAINT "selection_plans_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "discovery_items_ws_plan_item_uq" ON "discovery_items" USING btree ("workspace_id","plan_id","source_item_id") WHERE "discovery_items"."plan_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "discovery_items_ws_item_uq" ON "discovery_items" USING btree ("workspace_id","source_item_id") WHERE "discovery_items"."plan_id" is null;--> statement-breakpoint
CREATE INDEX "discovery_items_ws_status_idx" ON "discovery_items" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "discovery_items_plan_idx" ON "discovery_items" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX "selection_plans_ws_idx" ON "selection_plans" USING btree ("workspace_id");