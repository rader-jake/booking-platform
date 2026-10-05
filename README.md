# booking-platform

One shared booking API for many beauty businesses. Each business (tenant) has its own static booking page (on Vercel) that calls this API (on Railway). Postgres owns bookings. Google Calendar is read for free/busy and written with one event per confirmed booking.

First tenant: **Done Up by Rissa** (`doneupbyrissa`). Her page lives in the separate `doneup-booking` repo.

**Phase 1 (this repo today):** real availability and real bookings against Google Calendar.
**Not yet built:** Square deposits, SMS (Blooio), AI chat, admin dashboard. The code already has hooks for them (see [Phase 2 hooks](#phase-2-hooks)).

---

## Stack

Node 20+, TypeScript, Fastify, zod, Postgres with **Drizzle**, googleapis, luxon, Vitest.

Why Drizzle: the double-booking guard is a Postgres exclusion constraint on `tstzrange`. Drizzle lets that sit in a plain SQL migration next to the generated ones, with no separate query engine to ship.

## Layout

```
src/
  app.ts                 buildApp(): plugins, error shape, tenant resolution, routes
  server.ts              entry point (env → db → calendar provider → listen)
  env.ts                 zod-validated environment
  db/                    schema.ts, client.ts, migrate.ts
  domain/                pure logic: availability.ts (slot engine), pricing.ts
  booking/               DB + calendar orchestration: catalog, availability, bookings
  calendar/              CalendarProvider interface, Google implementation, in-memory fake
  notifications/         Notifier interface (currently does nothing)
  routes/                health, services, availability, bookings, waitlist
  seed/                  parse a tenant's index.html, upsert the tenant + catalog
scripts/seed.ts          seed CLI
drizzle/                 SQL migrations (0001 = btree_gist exclusion constraint)
test/                    Vitest suites (real Postgres via docker compose)
```

## Local development

```bash
npm install
npm run test:db          # Postgres 16 in Docker on :54329 (creates booking_dev + booking_test)
cp .env.example .env     # CALENDAR_PROVIDER=fake: no Google needed
DATABASE_URL=postgres://postgres:postgres@localhost:54329/booking_dev npm run db:migrate
DATABASE_URL=postgres://postgres:postgres@localhost:54329/booking_dev npm run seed -- \
  --html ../doneup-booking/index.html --calendar-id dev@calendar.test --origins http://localhost:4321
npm run dev              # http://localhost:3000
```

To run the page against it, serve the frontend repo locally, e.g. `python3 -m http.server 4321 --directory ../doneup-booking`. On `localhost`, the page automatically calls `http://localhost:3000`.

### Tests

```bash
npm run test:db   # once
npm test
```

Tests refuse to run against any non-local database. They cover:

- availability: grid, split shifts, lead time, minimum notice, max days ahead, DST fall-back and spring-forward, buffer, add-on durations
- an 8-way concurrent booking race where only the Postgres constraint decides the winner
- server-side price recompute
- calendar rollback, cancel retry, and the reconciliation flag
- tenant isolation, CORS, rate limits, and seeding

## API

All tenant routes live under `/api/:tenant`. An unknown slug returns 404.

Every error has the same shape: `{ "error": { "code": "...", "message": "...", "details"?: ... } }`.

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | `{ ok: true }` |
| GET | `/api/:tenant/services` | Catalog: services (with the add-on ids each accepts), add-ons, tenant timezone, deposit |
| GET | `/api/:tenant/availability?date=YYYY-MM-DD&serviceId=…&addons=a,b` | `{ date, timezone, durationMinutes, totalPriceCents, slots: ["2026-10-06T12:00:00-04:00", …] }` |
| POST | `/api/:tenant/bookings` | Body: `serviceId, addons[], startsAt, name, email, phone, notes?`. Returns `201 { booking, cancelToken }` |
| DELETE | `/api/:tenant/bookings/:id?token=…` | Cancels. Idempotent. A wrong token, unknown id, or another tenant's id all return 404 |
| POST | `/api/:tenant/waitlist` | Body: `serviceId, date, name, email, phone`. Stored only, for now |

Error codes you'll see: `VALIDATION_ERROR` / `INVALID_ADDON` / `DUPLICATE_ADDON` / `INVALID_START` / `INVALID_JSON` (400), `NOT_FOUND` (404), `SLOT_TAKEN` (409), `RATE_LIMITED` (429), `CALENDAR_UNAVAILABLE` (503), `INTERNAL` (500).

### Rules the server enforces

- **Availability:**
  - Total duration is the service plus its add-ons.
  - Starts sit on the tenant's slot grid inside that weekday's windows, and the whole appointment must end inside a window.
  - No start earlier than now plus `lead_time_minutes`.
  - No start inside the service's `min_days_notice`, counted in calendar days in the tenant's timezone.
  - Active bookings (including buffer) and Google free/busy across `google_calendar_id` plus `busy_calendar_ids` are subtracted.
  - If Google can't be read, the request fails closed with 503 rather than offering times that might be busy.
- **Bookings re-run availability.** A POST is accepted only if `startsAt` is exactly one of the starts the server would offer right now.
- **Pricing.** Price and duration always come from the server's rows. Unknown body fields, such as a client-sent price, are dropped. Add-ons must apply to the chosen service (a `service_addons` row) or be universal.
- **Times.** Everything is stored in UTC and computed in the tenant's timezone with luxon. Slots step in absolute minutes, so DST changes never duplicate or skip a start.

### Double-booking prevention

`drizzle/0001_booking_overlap_guard.sql` adds:

```sql
EXCLUDE USING gist (tenant_id WITH =, tstzrange(starts_at, blocked_until, '[)') WITH &&)
WHERE (status IN ('pending_deposit','confirmed'))
```

`blocked_until` is the end time plus the tenant's buffer at booking time. A violation (`23P01`) becomes a 409. Expired deposit holds are swept to `expired` inside the booking transaction before the insert, because a constraint can't reference `now()`.

### DB ↔ calendar consistency

- **Create (confirmed booking):** insert the booking, create the Google event, and store its id, all in one transaction. If Google fails, the transaction rolls back and the API returns 503. If the transaction fails after the event exists, the event is deleted (and logged if that delete also fails).
- **Cancel:** the DB is updated first so the slot frees immediately. The Google delete is retried (250 ms, 1 s, 3 s). If it still fails, the booking is flagged `calendar_sync_pending = true` and logged with the booking id. A leftover event can only over-block time, never cause a double booking.

Find bookings that need manual cleanup:

```sql
SELECT id, tenant_id, calendar_event_id FROM bookings WHERE calendar_sync_pending;
```

## Tenants

Tenant config lives in the `tenants` table: slug, name, timezone, weekly hours, slot interval, lead time, buffer, max days ahead, Google calendar ids, allowed origins, deposit amount, and hold length.

- Weekly hours are JSON keyed `"0"` (Sunday) to `"6"` (Saturday). Each day takes a list of windows, so split shifts work.
- Services and add-ons are rows in `services`, with `kind` = `service` / `addon` / `universal_addon`. Money is in integer cents.
- `service_addons` holds the applies-to links: which add-ons attach to which service.
- Adding a category or service is data-only.

**The seed never retypes data.** `scripts/seed.ts` evaluates the data block of the tenant's `index.html`, from `const STUDIO_HOURS` up to `const SERVICES = {};`, in an empty `node:vm` context. It validates the result with zod and upserts it.

- Re-running it re-syncs the catalog.
- Services removed from the page are deactivated, not deleted, because bookings reference them.
- It refuses non-local databases unless you pass `--confirm-remote`.

```bash
npm run seed -- --html ../doneup-booking/index.html \
  --slug doneupbyrissa --name "Done Up by Rissa" --timezone America/New_York \
  --calendar-id <calendar id> [--busy-calendars id1,id2] \
  --origins https://<her-site>.vercel.app,http://localhost:4321
```

### Google Calendar setup (per tenant)

1. In Google Calendar, the owner opens **Settings → [calendar] → Share with specific people** and adds `booking-backend@booking-platform-510716.iam.gserviceaccount.com` with **Make changes to events**. Do the same, with at least "See all event details", for any extra calendars that should block time.
2. Copy the **Calendar ID** from **Integrate calendar** and pass it to the seed as `--calendar-id`.
3. Until a calendar id is set, the tenant's availability returns 503 ("hasn't connected a calendar yet").

The service account key is read only from `GOOGLE_SERVICE_ACCOUNT_JSON_B64`. All Google calls go through `CalendarProvider`, so per-tenant OAuth can replace it later without touching booking code.

## Security

- **CORS:** only the tenant's `allowed_origins` get CORS headers.
- **Rate limits** (per IP):
  - 120/min on every route
  - 60/min on availability
  - 10/min on writes
- **Validation:** zod on every input, with length limits; 16 KB body limit.
- **Logs:** method and path only. No query strings (cancel tokens live there), headers, IPs, bodies, or customer details.
- **Cancel tokens:** 256-bit random, returned once, stored as SHA-256, compared in constant time.
- **Secrets:** only in env vars. `.gitignore` blocks `.env*` and service-account JSON files.

## Deploy to Railway

1. Push this repo to GitHub, e.g. `rader-jake/booking-platform`. Do not push the frontend's old `.env`; it now lives here as `.env.railway`, which git ignores.
2. In the existing Railway project (the one with the Postgres you created), choose **New → GitHub repo → booking-platform**. `railway.json` sets the build (`npm ci --include=dev && npm run build`), the start command (`npm start`, which runs migrations first), and the `/health` healthcheck.
3. Set the service variables:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}` (reference variable; uses the private network)
   - `CALENDAR_PROVIDER` = `google`
   - `GOOGLE_SERVICE_ACCOUNT_JSON_B64` = output of `base64 -i <key>.json | tr -d '\n'`
   - `NODE_ENV` = `production`
4. Deploy. Check that `https://<service>.up.railway.app/health` returns `{"ok":true}`.
5. Seed Rissa against the **public** database URL from your machine:
   ```bash
   DATABASE_URL="<DATABASE_PUBLIC_URL>" npm run seed -- --html ../doneup-booking/index.html \
     --calendar-id <her calendar id> --origins https://<her-site>.vercel.app --confirm-remote
   ```
6. In `doneup-booking/index.html`, set `API_BASE_URL` to the Railway URL (search for the `TODO`) and redeploy the page.

## Phase 2 hooks

- **Deposits (Square):**
  - Tenants with `deposit_cents` create `pending_deposit` bookings that hold the slot for `deposit_hold_minutes` (default 30) with no calendar event.
  - `confirmBooking()` in `src/booking/bookings.ts` is the Square-webhook entry point. It flips the booking to `confirmed` and writes the calendar event atomically (tested).
  - Bookings already return `depositUrl: null`; fill it with the Square payment link.
- **Notifications (Blooio SMS / email):** `Notifier` in `src/notifications/` is called on create, cancel, and waitlist join. It's a no-op today.

## Open questions (TODO — not guessed)

1. **8 AM Morning Luxe (+$50) / 5 PM After Hours (+$65).** Her hours are Tue 12–7, Wed–Fri 10–7, Sat 10–5, so 8 AM is outside them. For now both are **price-only universal add-ons**: they don't open extra slots. Decide whether they should unlock early/late slots and on which days. `TODO(open question 1)` in `src/seed/frontend-data.ts`.
2. **Empty categories.** Resolved: the page now has 32 services in 10 categories, and adding more is data-only (edit the page, re-run the seed).
3. **Deposit policy.** Amount is **$50** (`deposit_cents = 5000`), collected via **Square**. Still open:
   - refund and cancellation policy
   - hold length (30 minutes assumed)
   - what happens if payment lands after the hold expired and the slot was re-booked (`TODO(phase 2)` in `confirmBooking`)
4. **Minimum notice for non-bundle services.** Only the four bundle sets have 2 days (`minDaysNotice: 2` on the page); everything else is 0. That includes the Raw Heiress sets, which carry no "book ahead" flag on Acuity. Also confirm that "2 days" means calendar days, which is what's implemented, rather than 48 hours. `TODO(open question 4)` in `src/seed/frontend-data.ts`.

Smaller follow-ups:

- **`.ics` download:** removed from the page while a booking is only a hold. Add it back on a confirmed screen in phase 2.
- **Reconciliation:** no job yet for `calendar_sync_pending` bookings. The query above finds them.
- **Date chips:** the page builds them in the visitor's local timezone. Times are always shown and booked in the salon's timezone.
- **Key rotation:** the service-account key was shared in a chat during setup. Create a new key in Google Cloud and delete the old one before going live.
