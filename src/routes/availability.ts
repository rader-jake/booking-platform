import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { openStarts } from "../booking/availability.js";
import { loadSelection } from "../booking/catalog.js";
import { parseTenantDate, toTenantIso } from "../domain/availability.js";
import { badRequest } from "../lib/errors.js";
import { addonListQuery, dateSchema, keySchema } from "./schemas.js";

const Query = z.object({ date: dateSchema, serviceId: keySchema, addons: addonListQuery });

export async function availabilityRoutes(app: FastifyInstance) {
  app.get("/availability", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req) => {
    const q = Query.parse(req.query);
    const tenant = req.tenant;
    try {
      parseTenantDate(q.date, tenant.timezone);
    } catch {
      throw badRequest("VALIDATION_ERROR", "Invalid date");
    }
    const selection = await loadSelection(app.deps.db, tenant.id, q.serviceId, q.addons);
    const starts = await openStarts(app.deps, tenant, selection, q.date, app.deps.now());
    return {
      date: q.date,
      timezone: tenant.timezone,
      durationMinutes: selection.totalDurationMinutes,
      totalPriceCents: selection.totalPriceCents,
      slots: starts.map((t) => toTenantIso(t, tenant.timezone)),
    };
  });
}
