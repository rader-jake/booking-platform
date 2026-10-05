import { and, eq, notInArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { serviceAddons, services, tenants, type WeeklyHours } from "../db/schema.js";
import type { SeedService } from "./frontend-data.js";

export type TenantSeedInput = {
  slug: string;
  name: string;
  timezone: string;
  weeklyHours: WeeklyHours;
  slotIntervalMinutes: number;
  leadTimeMinutes: number;
  depositCents: number | null;
  googleCalendarId: string | null;
  busyCalendarIds: string[];
  allowedOrigins: string[];
};

/**
 * Idempotent: upserts the tenant and its catalog by key, rebuilds applies_to links, and
 * deactivates (never deletes) catalog rows that disappeared, since bookings reference them.
 */
export async function seedTenant(db: Db, input: TenantSeedInput, rows: SeedService[]): Promise<string> {
  return db.transaction(async (tx) => {
    const tenantValues = {
      name: input.name,
      timezone: input.timezone,
      weeklyHours: input.weeklyHours,
      slotIntervalMinutes: input.slotIntervalMinutes,
      leadTimeMinutes: input.leadTimeMinutes,
      depositCents: input.depositCents,
      googleCalendarId: input.googleCalendarId,
      busyCalendarIds: input.busyCalendarIds,
      allowedOrigins: input.allowedOrigins,
    };
    const [tenant] = await tx
      .insert(tenants)
      .values({ slug: input.slug, ...tenantValues })
      .onConflictDoUpdate({ target: tenants.slug, set: tenantValues })
      .returning({ id: tenants.id });
    const tenantId = tenant!.id;

    const idByKey = new Map<string, string>();
    for (const r of rows) {
      const values = {
        kind: r.kind,
        category: r.category,
        name: r.name,
        description: r.description,
        priceCents: r.priceCents,
        durationMinutes: r.durationMinutes,
        minDaysNotice: r.minDaysNotice,
        sortOrder: r.sortOrder,
        active: true,
      };
      const [row] = await tx
        .insert(services)
        .values({ tenantId, key: r.key, ...values })
        .onConflictDoUpdate({ target: [services.tenantId, services.key], set: values })
        .returning({ id: services.id });
      idByKey.set(r.key, row!.id);
    }

    await tx
      .update(services)
      .set({ active: false })
      .where(and(eq(services.tenantId, tenantId), notInArray(services.key, [...idByKey.keys()])));

    await tx.delete(serviceAddons).where(eq(serviceAddons.tenantId, tenantId));
    const links = rows.flatMap((r) =>
      r.addonKeys.map((k) => ({ tenantId, serviceId: idByKey.get(r.key)!, addonId: idByKey.get(k)! })),
    );
    if (links.length) await tx.insert(serviceAddons).values(links);

    return tenantId;
  });
}
