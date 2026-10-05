import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { cancelBooking, createBooking } from "../booking/bookings.js";
import { notFound } from "../lib/errors.js";
import { customerSchema, keySchema, WRITE_RATE_LIMIT } from "./schemas.js";

const CreateBody = z.object({
  serviceId: keySchema,
  addons: z.array(keySchema).max(20).default([]),
  startsAt: z.iso.datetime({ offset: true }),
  ...customerSchema,
  notes: z.string().trim().max(1000).optional(),
});
// Unknown keys (e.g. a client-sent price) are stripped by zod and never read.

const CancelParams = z.object({ id: z.string() });
const CancelQuery = z.object({ token: z.string().min(20).max(200) });

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

  app.delete("/bookings/:id", { config: WRITE_RATE_LIMIT }, async (req) => {
    const { id } = CancelParams.parse(req.params);
    if (!z.uuid().safeParse(id).success) throw notFound("Booking");
    const { token } = CancelQuery.parse(req.query);
    const booking = await cancelBooking({ ...app.deps, log: req.log }, req.tenant, id, token, app.deps.now());
    return { booking };
  });
}
