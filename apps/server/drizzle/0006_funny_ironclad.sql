ALTER TABLE "listings" ADD COLUMN "desc_images" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "source_items" ADD COLUMN "desc_images" jsonb DEFAULT '[]'::jsonb NOT NULL;