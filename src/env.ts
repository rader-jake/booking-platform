import { z } from "zod";

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().default(3000),
    HOST: z.string().default("0.0.0.0"),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
    DATABASE_URL: z.string().url(),
    CALENDAR_PROVIDER: z.enum(["google", "fake"]).default("google"),
    GOOGLE_SERVICE_ACCOUNT_JSON_B64: z.string().optional(),
    // Railway sits behind a proxy; needed for per-client rate limiting.
    TRUST_PROXY: z.coerce.boolean().default(true),
  })
  .refine((e) => e.CALENDAR_PROVIDER !== "google" || !!e.GOOGLE_SERVICE_ACCOUNT_JSON_B64, {
    message: "GOOGLE_SERVICE_ACCOUNT_JSON_B64 is required when CALENDAR_PROVIDER=google",
    path: ["GOOGLE_SERVICE_ACCOUNT_JSON_B64"],
  });

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    // Only print variable names and messages, never values.
    const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment: ${problems}`);
  }
  return parsed.data;
}
