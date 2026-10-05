import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createBooking } from "../booking/bookings.js";
import { customerSchema, keySchema, WRITE_RATE_LIMIT } from "./schemas.js";

const CreateBody = z.object({
  serviceId: keySchema,
  addons: z.array(keySchema).max(20).default([]),
  startsAt: z.iso.datetime({ offset: true }),
  ...customerSchema,
  notes: z.string().trim().max(1000).optional(),
});
// Unknown keys (e.g. a client-sent price) are stripped by zod and never read.

export async function bookingRoutes(app: FastifyInstance) {
  app.post("/bookings", { config: WRITE_RATE_LIMIT }, async (req, reply) => {
    const body = CreateBody.parse(req.body);
    const result = await createBooking(
      { ...app.deps, log: req.log },
      req.tenant,
      {
        serviceKey: body.serviceId,
        addonKeys: body.addons,
        startsAt: new Date(body.startsAt),
        name: body.name,
        email: body.email,
        phone: body.phone,
        notes: body.notes,
      },
      app.deps.now(),
    );
    return reply.status(201).send(result);
  });
}
