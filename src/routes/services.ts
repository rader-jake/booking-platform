import type { FastifyInstance } from "fastify";
import { listCatalog } from "../booking/catalog.js";

export async function serviceRoutes(app: FastifyInstance) {
  app.get("/services", async (req) => {
    const catalog = await listCatalog(app.deps.db, req.tenant.id);
    return { tenant: { name: req.tenant.name, timezone: req.tenant.timezone, depositCents: req.tenant.depositCents }, ...catalog };
  });
}
