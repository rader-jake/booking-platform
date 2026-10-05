import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/** "HH:MM" wall-clock times in the tenant's timezone. */
export type TimeWindow = { start: string; end: string };
/** Keyed by weekday, 0 = Sunday … 6 = Saturday. Several windows per day = split shifts. */
export type WeeklyHours = Partial<Record<"0" | "1" | "2" | "3" | "4" | "5" | "6", TimeWindow[]>>;

export const serviceKind = pgEnum("service_kind", ["service", "addon", "universal_addon"]);
export const bookingStatus = pgEnum("booking_status", ["pending_deposit", "confirmed", "cancelled", "expired"]);

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  timezone: text("timezone").notNull(),
  weeklyHours: jsonb("weekly_hours").$type<WeeklyHours>().notNull(),
  slotIntervalMinutes: integer("slot_interval_minutes").notNull().default(30),
  leadTimeMinutes: integer("lead_time_minutes").notNull().default(180),
  bufferMinutes: integer("buffer_minutes").notNull().default(0),
  maxDaysAhead: integer("max_days_ahead").notNull().default(90),
  googleCalendarId: text("google_calendar_id"),
  busyCalendarIds: text("busy_calendar_ids").array().notNull().default(sql`'{}'::text[]`),
  allowedOrigins: text("allowed_origins").array().notNull().default(sql`'{}'::text[]`),
  // Phase 2 (payments). null/0 = bookings confirm immediately.
  depositCents: integer("deposit_cents"),
  depositHoldMinutes: integer("deposit_hold_minutes").notNull().default(30),
  createdAt: createdAt(),
});

export const services = pgTable(
  "services",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
    /** Stable public id (the frontend's data-id, e.g. "signature-install"). */
    key: text("key").notNull(),
    kind: serviceKind("kind").notNull(),
    category: text("category"),
    name: text("name").notNull(),
    description: text("description"),
    priceCents: integer("price_cents").notNull(),
    durationMinutes: integer("duration_minutes").notNull(),
    minDaysNotice: integer("min_days_notice").notNull().default(0),
    sortOrder: integer("sort_order").notNull().default(0),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("services_tenant_key_uq").on(t.tenantId, t.key)],
);

/** applies_to: which add-ons may be attached to which service. Universal add-ons need no rows. */
export const serviceAddons = pgTable(
  "service_addons",
  {
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
    serviceId: uuid("service_id").notNull().references(() => services.id, { onDelete: "cascade" }),
    addonId: uuid("addon_id").notNull().references(() => services.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.serviceId, t.addonId] })],
);

export const bookings = pgTable(
  "bookings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
    serviceId: uuid("service_id").notNull().references(() => services.id),
    status: bookingStatus("status").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    /** ends_at + the tenant's buffer at booking time; the overlap constraint uses this. */
    blockedUntil: timestamp("blocked_until", { withTimezone: true }).notNull(),
    totalPriceCents: integer("total_price_cents").notNull(),
    totalDurationMinutes: integer("total_duration_minutes").notNull(),
    depositCents: integer("deposit_cents"),
    holdExpiresAt: timestamp("hold_expires_at", { withTimezone: true }),
    customerName: text("customer_name").notNull(),
    customerEmail: text("customer_email").notNull(),
    customerPhone: text("customer_phone").notNull(),
    notes: text("notes"),
    calendarEventId: text("calendar_event_id"),
    /** Set when a calendar delete failed after retries; needs reconciliation. */
    calendarSyncPending: boolean("calendar_sync_pending").notNull().default(false),
    cancelTokenHash: text("cancel_token_hash").notNull(),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("bookings_tenant_starts_idx").on(t.tenantId, t.startsAt)],
  // The double-booking exclusion constraint lives in a hand-written migration (drizzle can't express it).
);

export const bookingAddons = pgTable(
  "booking_addons",
  {
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
    bookingId: uuid("booking_id").notNull().references(() => bookings.id, { onDelete: "cascade" }),
    addonId: uuid("addon_id").notNull().references(() => services.id),
    // Snapshot at booking time so later price edits don't rewrite history.
    name: text("name").notNull(),
    priceCents: integer("price_cents").notNull(),
    durationMinutes: integer("duration_minutes").notNull(),
  },
  (t) => [primaryKey({ columns: [t.bookingId, t.addonId] })],
);

export const waitlistEntries = pgTable(
  "waitlist_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
    serviceId: uuid("service_id").notNull().references(() => services.id),
    preferredDate: date("preferred_date").notNull(),
    customerName: text("customer_name").notNull(),
    customerEmail: text("customer_email").notNull(),
    customerPhone: text("customer_phone").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("waitlist_tenant_date_idx").on(t.tenantId, t.preferredDate)],
);

export type Tenant = typeof tenants.$inferSelect;
export type Service = typeof services.$inferSelect;
export type Booking = typeof bookings.$inferSelect;

export const ACTIVE_STATUSES = ["pending_deposit", "confirmed"] as const;
