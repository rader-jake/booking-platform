CREATE TYPE "public"."booking_status" AS ENUM('pending_deposit', 'confirmed', 'cancelled', 'expired');--> statement-breakpoint
CREATE TYPE "public"."service_kind" AS ENUM('service', 'addon', 'universal_addon');--> statement-breakpoint
CREATE TABLE "booking_addons" (
	"tenant_id" uuid NOT NULL,
	"booking_id" uuid NOT NULL,
	"addon_id" uuid NOT NULL,
	"name" text NOT NULL,
	"price_cents" integer NOT NULL,
	"duration_minutes" integer NOT NULL,
	CONSTRAINT "booking_addons_booking_id_addon_id_pk" PRIMARY KEY("booking_id","addon_id")
);
--> statement-breakpoint
CREATE TABLE "bookings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"status" "booking_status" NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"blocked_until" timestamp with time zone NOT NULL,
	"total_price_cents" integer NOT NULL,
	"total_duration_minutes" integer NOT NULL,
	"deposit_cents" integer,
	"hold_expires_at" timestamp with time zone,
	"customer_name" text NOT NULL,
	"customer_email" text NOT NULL,
	"customer_phone" text NOT NULL,
	"notes" text,
	"calendar_event_id" text,
	"calendar_sync_pending" boolean DEFAULT false NOT NULL,
	"cancel_token_hash" text NOT NULL,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_addons" (
	"tenant_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"addon_id" uuid NOT NULL,
	CONSTRAINT "service_addons_service_id_addon_id_pk" PRIMARY KEY("service_id","addon_id")
);
--> statement-breakpoint
CREATE TABLE "services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"key" text NOT NULL,
	"kind" "service_kind" NOT NULL,
	"category" text,
	"name" text NOT NULL,
	"description" text,
	"price_cents" integer NOT NULL,
	"duration_minutes" integer NOT NULL,
	"min_days_notice" integer DEFAULT 0 NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"timezone" text NOT NULL,
	"weekly_hours" jsonb NOT NULL,
	"slot_interval_minutes" integer DEFAULT 30 NOT NULL,
	"lead_time_minutes" integer DEFAULT 180 NOT NULL,
	"buffer_minutes" integer DEFAULT 0 NOT NULL,
	"max_days_ahead" integer DEFAULT 90 NOT NULL,
	"google_calendar_id" text,
	"busy_calendar_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"allowed_origins" text[] DEFAULT '{}'::text[] NOT NULL,
	"deposit_cents" integer,
	"deposit_hold_minutes" integer DEFAULT 30 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "waitlist_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"preferred_date" date NOT NULL,
	"customer_name" text NOT NULL,
	"customer_email" text NOT NULL,
	"customer_phone" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "booking_addons" ADD CONSTRAINT "booking_addons_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_addons" ADD CONSTRAINT "booking_addons_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_addons" ADD CONSTRAINT "booking_addons_addon_id_services_id_fk" FOREIGN KEY ("addon_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_addons" ADD CONSTRAINT "service_addons_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_addons" ADD CONSTRAINT "service_addons_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_addons" ADD CONSTRAINT "service_addons_addon_id_services_id_fk" FOREIGN KEY ("addon_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bookings_tenant_starts_idx" ON "bookings" USING btree ("tenant_id","starts_at");--> statement-breakpoint
CREATE UNIQUE INDEX "services_tenant_key_uq" ON "services" USING btree ("tenant_id","key");--> statement-breakpoint
CREATE INDEX "waitlist_tenant_date_idx" ON "waitlist_entries" USING btree ("tenant_id","preferred_date");