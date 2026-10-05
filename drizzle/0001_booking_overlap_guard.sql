-- Double-booking prevention enforced by Postgres, not app code.
-- Two active bookings for the same tenant may not overlap (including buffer).
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_no_overlap"
  EXCLUDE USING gist (
    "tenant_id" WITH =,
    tstzrange("starts_at", "blocked_until", '[)') WITH &&
  )
  WHERE ("status" IN ('pending_deposit', 'confirmed'));
--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_valid_range" CHECK ("ends_at" > "starts_at" AND "blocked_until" >= "ends_at");
--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_non_negative" CHECK ("price_cents" >= 0 AND "duration_minutes" >= 0 AND "min_days_notice" >= 0);
