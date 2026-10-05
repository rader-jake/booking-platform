import { z } from "zod";

export const keySchema = z.string().trim().min(1).max(64).regex(/^[a-z0-9-]+$/, "invalid id");
export const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
/** "a,b,c" in a query string → ["a","b","c"]. */
export const addonListQuery = z
  .string()
  .max(1000)
  .optional()
  .transform((s) => (s ? s.split(",").map((x) => x.trim()).filter(Boolean) : []))
  .pipe(z.array(keySchema).max(20));

export const customerSchema = {
  name: z.string().trim().min(1).max(100),
  email: z.email().max(254),
  phone: z
    .string()
    .trim()
    .max(25)
    .regex(/^\+?[0-9 ().-]{7,25}$/, "invalid phone number"),
};

/** Stricter per-IP limit for writes (the global default is 120/min). */
export const WRITE_RATE_LIMIT = { rateLimit: { max: 10, timeWindow: "1 minute" } };
