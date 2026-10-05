import { badRequest } from "../lib/errors.js";

export type CatalogItem = {
  id: string;
  key: string;
  kind: "service" | "addon" | "universal_addon";
  name: string;
  priceCents: number;
  durationMinutes: number;
  minDaysNotice: number;
};

export type Selection = {
  service: CatalogItem;
  addons: CatalogItem[];
  totalPriceCents: number;
  totalDurationMinutes: number;
};

/**
 * Prices and durations always come from the server's catalog, never the client.
 * `applicableAddons` = add-ons linked to this service plus universal add-ons.
 */
export function resolveSelection(service: CatalogItem, requestedAddonKeys: string[], applicableAddons: CatalogItem[]): Selection {
  if (new Set(requestedAddonKeys).size !== requestedAddonKeys.length) {
    throw badRequest("DUPLICATE_ADDON", "Each add-on can only be selected once");
  }
  const byKey = new Map(applicableAddons.map((a) => [a.key, a]));
  const invalid = requestedAddonKeys.filter((k) => !byKey.has(k));
  if (invalid.length) {
    throw badRequest("INVALID_ADDON", "One or more add-ons can't be added to this service", { addons: invalid });
  }
  const addons = requestedAddonKeys.map((k) => byKey.get(k)!);
  return {
    service,
    addons,
    totalPriceCents: addons.reduce((sum, a) => sum + a.priceCents, service.priceCents),
    totalDurationMinutes: addons.reduce((sum, a) => sum + a.durationMinutes, service.durationMinutes),
  };
}
