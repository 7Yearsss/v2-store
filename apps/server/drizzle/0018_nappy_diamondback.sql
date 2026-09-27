ALTER TABLE "orders" RENAME COLUMN "customer" TO "customer_enc";--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "customer_enc" SET DATA TYPE text USING "customer_enc"::text;
