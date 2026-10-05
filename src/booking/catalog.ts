import { and, asc, eq, inArray, or } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { serviceAddons, services } from "../db/schema.js";
import { resolveSelection, type CatalogItem, type Selection } from "../domain/pricing.js";
import { notFound } from "../lib/errors.js";

const catalogColumns = {
  id: services.id,
  key: services.key,
  kind: services.kind,
  name: services.name,
  priceCents: services.priceCents,
  durationMinutes: services.durationMinutes,
  minDaysNotice: services.minDaysNotice,
};

/** Loads a bookable service + requested add-ons for one tenant and recomputes totals. */
export async function loadSelection(db: Db, tenantId: string, serviceKey: string, addonKeys: string[]): Promise<Selection> {
  const [service] = await db
    .select(catalogColumns)
    .from(services)
    .where(and(eq(services.tenantId, tenantId), eq(services.key, serviceKey), eq(services.kind, "service"), eq(services.active, true)));
  if (!service) throw notFound("Service");

  const applicable: CatalogItem[] = addonKeys.length
    ? await db
        .select(catalogColumns)
        .from(services)
        .leftJoin(
          serviceAddons,
          and(eq(serviceAddons.addonId, services.id), eq(serviceAddons.serviceId, service.id), eq(serviceAddons.tenantId, tenantId)),
        )
        .where(
          and(
            eq(services.tenantId, tenantId),
            eq(services.active, true),
            inArray(services.key, addonKeys),
            or(eq(services.kind, "universal_addon"), and(eq(services.kind, "addon"), eq(serviceAddons.serviceId, service.id))),
          ),
        )
    : [];

  return resolveSelection(service, addonKeys, applicable);
}

/** Public catalog for GET /services. */
export async function listCatalog(db: Db, tenantId: string) {
  const rows = await db
    .select()
    .from(services)
    .where(and(eq(services.tenantId, tenantId), eq(services.active, true)))
    .orderBy(asc(services.sortOrder));
  const links = await db
    .select({ serviceId: serviceAddons.serviceId, addonId: serviceAddons.addonId })
    .from(serviceAddons)
    .where(eq(serviceAddons.tenantId, tenantId));

  const keyById = new Map(rows.map((r) => [r.id, r.key]));
  const universal = rows.filter((r) => r.kind === "universal_addon").map((r) => r.key);
  const addonsFor = (serviceId: string) => [
    ...links.filter((l) => l.serviceId === serviceId && keyById.has(l.addonId)).map((l) => keyById.get(l.addonId)!),
    ...universal,
  ];

  return {
    services: rows
      .filter((r) => r.kind === "service")
      .map((r) => ({
        id: r.key,
        name: r.name,
        category: r.category,
        description: r.description,
        priceCents: r.priceCents,
        durationMinutes: r.durationMinutes,
        minDaysNotice: r.minDaysNotice,
        addons: addonsFor(r.id),
      })),
    addons: rows
      .filter((r) => r.kind !== "service")
      .map((r) => ({
        id: r.key,
        name: r.name,
        priceCents: r.priceCents,
        durationMinutes: r.durationMinutes,
        universal: r.kind === "universal_addon",
      })),
  };
}
