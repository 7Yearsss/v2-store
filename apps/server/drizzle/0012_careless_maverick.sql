CREATE TABLE "freight_forwarders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"address" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"system_type" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"remote_line_item_id" text,
	"remote_variant_id" text,
	"title" text NOT NULL,
	"sku" text,
	"qty" integer DEFAULT 1 NOT NULL,
	"unit_price" real,
	"listing_id" uuid,
	"source_item_id" uuid,
	"source_sku_id" text,
	"mapping" text DEFAULT 'unmatched' NOT NULL,
	"procure_status" text DEFAULT 'none' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"remote_id" text NOT NULL,
	"name" text,
	"financial_status" text,
	"fulfillment_status" text,
	"status" text DEFAULT 'new' NOT NULL,
	"customer" jsonb,
	"shipping_address_enc" text,
	"currency" text,
	"subtotal" real,
	"total" real,
	"items_count" integer,
	"placed_at" timestamp with time zone,
	"reviewed_at" timestamp with time zone,
	"synced_at" timestamp with time zone,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_order_items" (
	"purchase_order_id" uuid NOT NULL,
	"order_item_id" uuid NOT NULL,
	"qty" integer DEFAULT 1 NOT NULL,
	"unit_price_cny" real,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_order_items_purchase_order_id_order_item_id_pk" PRIMARY KEY("purchase_order_id","order_item_id")
);
--> statement-breakpoint
CREATE TABLE "purchase_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" text DEFAULT 'manual' NOT NULL,
	"source_platform" text DEFAULT '1688' NOT NULL,
	"source_seller" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"source_order_id" text,
	"domestic_tracking" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"intl_tracking" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"forwarder_id" uuid,
	"cost_total_cny" real,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shipments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"purchase_order_id" uuid,
	"carrier" text,
	"tracking_no" text,
	"tracking_url" text,
	"remote_fulfillment_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"last_error" text,
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
ALTER TABLE "listings" ADD COLUMN "remote_variant_map" jsonb;--> statement-breakpoint
ALTER TABLE "source_items" ADD COLUMN "availability" text DEFAULT 'ok' NOT NULL;--> statement-breakpoint
ALTER TABLE "source_items" ADD COLUMN "delisted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "source_items" ADD COLUMN "last_scanned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "source_items" ADD COLUMN "collected_via" text;--> statement-breakpoint
ALTER TABLE "stores" ADD COLUMN "orders_cursor" text;--> statement-breakpoint
ALTER TABLE "freight_forwarders" ADD CONSTRAINT "freight_forwarders_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_source_item_id_source_items_id_fk" FOREIGN KEY ("source_item_id") REFERENCES "public"."source_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_forwarder_id_freight_forwarders_id_fk" FOREIGN KEY ("forwarder_id") REFERENCES "public"."freight_forwarders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_changes" ADD CONSTRAINT "source_changes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_changes" ADD CONSTRAINT "source_changes_source_item_id_source_items_id_fk" FOREIGN KEY ("source_item_id") REFERENCES "public"."source_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "freight_forwarders_ws_idx" ON "freight_forwarders" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "order_items_order_line_uq" ON "order_items" USING btree ("order_id","remote_line_item_id");--> statement-breakpoint
CREATE INDEX "order_items_order_idx" ON "order_items" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "order_items_source_idx" ON "order_items" USING btree ("source_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_store_remote_uq" ON "orders" USING btree ("store_id","remote_id");--> statement-breakpoint
CREATE INDEX "orders_ws_status_idx" ON "orders" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "orders_ws_created_idx" ON "orders" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "purchase_order_items_item_idx" ON "purchase_order_items" USING btree ("order_item_id");--> statement-breakpoint
CREATE INDEX "purchase_orders_ws_status_idx" ON "purchase_orders" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "shipments_order_idx" ON "shipments" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "shipments_ws_status_idx" ON "shipments" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "source_changes_ws_item_detected_idx" ON "source_changes" USING btree ("workspace_id","source_item_id","detected_at");--> statement-breakpoint
CREATE INDEX "source_changes_pending_idx" ON "source_changes" USING btree ("workspace_id","source_item_id") WHERE "source_changes"."applied_at" is null;--> statement-breakpoint
CREATE INDEX "listings_ws_source_changed_idx" ON "listings" USING btree ("workspace_id","source_changed_at");