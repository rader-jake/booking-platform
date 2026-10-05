import vm from "node:vm";
import { z } from "zod";

/**
 * Pulls the service menu, add-ons and hours out of a tenant's static booking page so the
 * seed never retypes them. The page's <script> declares plain object literals between
 * `const STUDIO_HOURS` and `const SERVICES = {}`; that slice is evaluated in an empty
 * vm context (no DOM, no globals) and validated.
 */

const AddonSchema = z.object({
  name: z.string().min(1),
  price: z.number().nonnegative(),
  duration: z.number().int().nonnegative(),
});

const FrontendServiceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  price: z.number().nonnegative(),
  duration: z.number().int().positive(),
  desc: z.string().optional(),
  addons: z.array(z.string()).optional(),
  minDaysNotice: z.number().int().nonnegative().optional(),
});

const FrontendDataSchema = z.object({
  STUDIO_HOURS: z.record(z.string(), z.array(z.object({ open: z.number(), close: z.number() })).nullable()),
  DEPOSIT_AMOUNT: z.number().nonnegative().nullable(),
  SLOT_INTERVAL: z.number().int().positive(),
  LEAD_TIME_MIN: z.number().int().nonnegative(),
  ADDONS: z.record(z.string(), AddonSchema),
  UNIVERSAL_ADDONS: z.record(z.string(), AddonSchema),
  CATEGORIES: z.array(
    z.object({
      name: z.string().min(1),
      note: z.string().optional(),
      services: z.array(FrontendServiceSchema),
    }),
  ),
});

export type FrontendData = z.infer<typeof FrontendDataSchema>;

const START_MARKER = "const STUDIO_HOURS";
const END_MARKER = "const SERVICES = {};";

export function extractFrontendData(html: string): FrontendData {
  const start = html.indexOf(START_MARKER);
  const end = html.indexOf(END_MARKER);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`Could not find the data block (${START_MARKER} … ${END_MARKER}) in the HTML`);
  }
  const code =
    html.slice(start, end) +
    "\n;({ STUDIO_HOURS, DEPOSIT_AMOUNT, SLOT_INTERVAL, LEAD_TIME_MIN, ADDONS, UNIVERSAL_ADDONS, CATEGORIES })";
  const raw = vm.runInNewContext(code, Object.create(null), { timeout: 1000 });
  return FrontendDataSchema.parse(JSON.parse(JSON.stringify(raw)));
}

function minutesToHHMM(mins: number): string {
  return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
}

export function toWeeklyHours(studioHours: FrontendData["STUDIO_HOURS"]) {
  const out: Record<string, { start: string; end: string }[]> = {};
  for (const [day, windows] of Object.entries(studioHours)) {
    if (windows && windows.length) {
      out[day] = windows.map((w) => ({ start: minutesToHHMM(w.open), end: minutesToHHMM(w.close) }));
    }
  }
  return out;
}

const dollarsToCents = (n: number) => Math.round(n * 100);

export type SeedService = {
  key: string;
  kind: "service" | "addon" | "universal_addon";
  category: string | null;
  name: string;
  description: string | null;
  priceCents: number;
  durationMinutes: number;
  minDaysNotice: number;
  sortOrder: number;
  addonKeys: string[];
};

export function toSeedServices(data: FrontendData): SeedService[] {
  const rows: SeedService[] = [];
  let order = 0;
  for (const cat of data.CATEGORIES) {
    for (const s of cat.services) {
      rows.push({
        key: s.id,
        kind: "service",
        category: cat.name,
        name: s.name,
        description: s.desc ?? null,
        priceCents: dollarsToCents(s.price),
        durationMinutes: s.duration,
        // TODO(open question 4): minimum notice for non-bundle services is unknown; 0 until Rissa decides.
        minDaysNotice: s.minDaysNotice ?? 0,
        sortOrder: order++,
        addonKeys: s.addons ?? [],
      });
    }
  }
  const addAddons = (map: FrontendData["ADDONS"], kind: "addon" | "universal_addon") => {
    for (const [key, a] of Object.entries(map)) {
      rows.push({
        key,
        kind,
        category: null,
        name: a.name,
        description: null,
        priceCents: dollarsToCents(a.price),
        durationMinutes: a.duration,
        minDaysNotice: 0,
        sortOrder: order++,
        addonKeys: [],
      });
    }
  };
  addAddons(data.ADDONS, "addon");
  // TODO(open question 1): 8AM Morning Luxe / 5PM After Hours are outside normal hours.
  // For now they are price-only universal add-ons; they do not open extra slots.
  addAddons(data.UNIVERSAL_ADDONS, "universal_addon");

  const keys = new Set(rows.map((r) => r.key));
  if (keys.size !== rows.length) throw new Error("Duplicate service/add-on keys in frontend data");
  for (const r of rows) {
    for (const k of r.addonKeys) {
      if (!data.ADDONS[k]) throw new Error(`Service "${r.key}" lists unknown add-on "${k}"`);
    }
  }
  return rows;
}
