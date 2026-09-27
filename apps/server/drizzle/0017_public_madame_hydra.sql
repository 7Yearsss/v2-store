ALTER TABLE "freight_forwarders" RENAME COLUMN "address" TO "address_enc";
--> statement-breakpoint
ALTER TABLE "freight_forwarders" ALTER COLUMN "address_enc" SET DATA TYPE text USING "address_enc"::text;
