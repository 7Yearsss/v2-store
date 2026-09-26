CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"actor" text DEFAULT 'system' NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "publish_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"listing_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"fields_snapshot" jsonb NOT NULL,
	"error" text,
	"error_code" text,
	"remote_id" text,
	"remote_url" text,
	"retry_of" uuid,
	"job_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "publish_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"listing_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "link_status" text DEFAULT 'unlinked' NOT NULL;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "sync_policy" jsonb DEFAULT '{"stock":"notify","content":"notify","price":"notify"}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "remote_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "remote_drift" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "last_pulled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "last_auto_action" jsonb;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_attempts" ADD CONSTRAINT "publish_attempts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_attempts" ADD CONSTRAINT "publish_attempts_run_id_publish_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."publish_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_attempts" ADD CONSTRAINT "publish_attempts_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_attempts" ADD CONSTRAINT "publish_attempts_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_attempts" ADD CONSTRAINT "publish_attempts_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_runs" ADD CONSTRAINT "publish_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_runs" ADD CONSTRAINT "publish_runs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_logs_ws_entity_idx" ON "audit_logs" USING btree ("workspace_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_logs_ws_created_idx" ON "audit_logs" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "publish_attempts_run_idx" ON "publish_attempts" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "publish_attempts_listing_idx" ON "publish_attempts" USING btree ("listing_id");--> statement-breakpoint
CREATE INDEX "publish_attempts_ws_status_idx" ON "publish_attempts" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "publish_runs_ws_created_idx" ON "publish_runs" USING btree ("workspace_id","created_at");--> statement-breakpoint
-- 回填：已有 remoteId 的刊登视为已链接；已标 DELETED 的视为远端已删
UPDATE "listings" SET "link_status" = 'linked' WHERE "remote_id" IS NOT NULL AND "remote_status" IS DISTINCT FROM 'DELETED';--> statement-breakpoint
UPDATE "listings" SET "link_status" = 'remote_deleted' WHERE "remote_status" = 'DELETED';
