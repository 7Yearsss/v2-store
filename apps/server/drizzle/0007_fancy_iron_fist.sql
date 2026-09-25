CREATE TABLE "term_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"lang" text DEFAULT '' NOT NULL,
	"source_text" text NOT NULL,
	"target_text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "term_mappings" ADD CONSTRAINT "term_mappings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "term_mappings_ws_lang_src_uq" ON "term_mappings" USING btree ("workspace_id","lang","source_text");--> statement-breakpoint
CREATE INDEX "term_mappings_ws_idx" ON "term_mappings" USING btree ("workspace_id");