import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { eq } from "drizzle-orm";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { ZodError } from "zod";
import type { CalendarProvider } from "./calendar/provider.js";
import type { Db } from "./db/client.js";
import { tenants, type Tenant } from "./db/schema.js";
import { AppError, CalendarError, notFound } from "./lib/errors.js";
import { noopNotifier, type Notifier } from "./notifications/index.js";
import { availabilityRoutes } from "./routes/availability.js";
import { bookingRoutes } from "./routes/bookings.js";
import { serviceRoutes } from "./routes/services.js";
import { waitlistRoutes } from "./routes/waitlist.js";

export type AppDeps = {
  db: Db;
  calendar: CalendarProvider;
  notifier?: Notifier;
  /** Injectable clock for tests. */
  now?: () => Date;
  logLevel?: string;
  trustProxy?: boolean;
  /** Disable to run fast tests that fire many requests from one IP. */
  rateLimit?: boolean;
  calendarRetryDelaysMs?: number[];
};

declare module "fastify" {
  interface FastifyRequest {
    tenant: Tenant;
  }
  interface FastifyInstance {
    deps: Required<Pick<AppDeps, "db" | "calendar" | "notifier" | "now">> & Pick<AppDeps, "calendarRetryDelaysMs">;
  }
}

const SLUG_RE = /^[a-z0-9-]{1,64}$/;
const slugFromUrl = (url: string) => /^\/api\/([^/?#]+)/.exec(url)?.[1];

export async function findTenant(db: Db, slug: string | undefined): Promise<Tenant | undefined> {
  if (!slug || !SLUG_RE.test(slug)) return undefined;
  const [tenant] = await db.select().from(tenants).where(eq(tenants.slug, slug));
  return tenant;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    trustProxy: deps.trustProxy ?? true,
    bodyLimit: 16 * 1024,
    logger: {
      level: deps.logLevel ?? "info",
      // No PII in logs: path only (query strings can hold cancel tokens), no headers, no IPs, no bodies.
      serializers: {
        req: (req: FastifyRequest) => ({ id: req.id, method: req.method, path: req.url.split("?")[0] }),
      },
    },
  });

  app.decorate("deps", {
    db: deps.db,
    calendar: deps.calendar,
    notifier: deps.notifier ?? noopNotifier,
    now: deps.now ?? (() => new Date()),
    calendarRetryDelaysMs: deps.calendarRetryDelaysMs,
  });
  app.decorateRequest("tenant", null as unknown as Tenant);

  // CORS: each tenant's allowed_origins. No match = no CORS headers, so browsers block it.
  await app.register(cors, {
    delegator: (req, cb) => {
      const origin = req.headers.origin;
      if (!origin) return cb(null, { origin: false });
      findTenant(deps.db, slugFromUrl(req.url ?? ""))
        .then((t) => cb(null, { origin: !!t?.allowedOrigins.includes(origin), methods: ["GET", "POST", "DELETE"], maxAge: 600 }))
        .catch((err) => cb(err as Error, { origin: false }));
    },
  });

  if (deps.rateLimit !== false) {
    await app.register(rateLimit, {
      global: true,
      max: 120,
      timeWindow: "1 minute",
      errorResponseBuilder: (_req, ctx) =>
        new AppError(ctx.statusCode, "RATE_LIMITED", `Too many requests. Try again in ${ctx.after}.`),
    });
  }

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err instanceof ZodError) {
      const details = err.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
      return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: "Invalid request", details } });
    }
    if (err instanceof CalendarError) {
      req.log.error({ err: { name: err.name, message: err.message } }, "calendar error");
      return reply.status(503).send({ error: { code: "CALENDAR_UNAVAILABLE", message: "The calendar is temporarily unavailable." } });
    }
    const fe = err as { statusCode?: number; code?: string; message?: string };
    if (fe.statusCode && fe.statusCode >= 400 && fe.statusCode < 500) {
      return reply.status(fe.statusCode).send({ error: { code: fe.code ?? "BAD_REQUEST", message: fe.message ?? "Bad request" } });
    }
    req.log.error({ err }, "unhandled error");
    return reply.status(500).send({ error: { code: "INTERNAL", message: "Something went wrong." } });
  });

  app.setNotFoundHandler((_req, reply) => {
    reply.status(404).send({ error: { code: "NOT_FOUND", message: "Route not found" } });
  });

  app.get("/health", async () => ({ ok: true }));

  await app.register(
    async (scope) => {
      scope.addHook("preHandler", async (req) => {
        const tenant = await findTenant(deps.db, (req.params as { tenant?: string }).tenant);
        if (!tenant) throw notFound("Business");
        req.tenant = tenant;
      });
      await scope.register(serviceRoutes);
      await scope.register(availabilityRoutes);
      await scope.register(bookingRoutes);
      await scope.register(waitlistRoutes);
    },
    { prefix: "/api/:tenant" },
  );

  return app;
}
