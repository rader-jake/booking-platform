import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { DateTime } from "luxon";
import { z } from "zod";
import { services, waitlistEntries } from "../db/schema.js";
import { parseTenantDate } from "../domain/availability.js";
import { badRequest, notFound } from "../lib/errors.js";
import { customerSchema, dateSchema, keySchema, WRITE_RATE_LIMIT } from "./schemas.js";

const Body = z.object({ serviceId: keySchema, date: dateSchema, ...customerSchema });

export async function waitlistRoutes(app: FastifyInstance) {
  app.post("/waitlist", { config: WRITE_RATE_LIMIT }, async (req, reply) => {
    const body = Body.parse(req.body);
    const tenant = req.tenant;

    let day: DateTime;
    try {
      day = parseTenantDate(body.date, tenant.timezone);
    } catch {
      throw badRequest("VALIDATION_ERROR", "Invalid date");
    }
    const today = DateTime.fromJSDate(app.deps.now(), { zone: tenant.timezone }).startOf("day");
    if (day < today) throw badRequest("VALIDATION_ERROR", "Date is in the past");

    const [service] = await app.deps.db
      .select({ id: services.id })
      .from(services)
      .where(and(eq(services.tenantId, tenant.id), eq(services.key, body.serviceId), eq(services.kind, "service"), eq(services.active, true)));
    if (!service) throw notFound("Service");

    // Stored only for now; notifications arrive in phase 2.
    const [entry] = await app.deps.db
      .insert(waitlistEntries)
      .values({
        tenantId: tenant.id,
        serviceId: service.id,
        preferredDate: body.date,
        customerName: body.name,
        customerEmail: body.email,
        customerPhone: body.phone,
      })
      .returning({ id: waitlistEntries.id });
    app.deps.notifier.waitlistJoined(tenant.slug, entry!.id).catch((e) => req.log.warn({ err: (e as Error).message }, "notifier failed"));
    return reply.status(201).send({ id: entry!.id });
  });
}
