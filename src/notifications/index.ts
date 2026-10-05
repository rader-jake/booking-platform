import type { Booking } from "../db/schema.js";

/**
 * Hook for customer/owner notifications (phase 2: SMS via Blooio, email). Calls are
 * fire-and-forget from the caller's point of view and must never fail a booking.
 */
export interface Notifier {
  bookingCreated(tenantSlug: string, booking: Booking): Promise<void>;
  bookingCancelled(tenantSlug: string, booking: Booking): Promise<void>;
  waitlistJoined(tenantSlug: string, entryId: string): Promise<void>;
}

export const noopNotifier: Notifier = {
  async bookingCreated() {},
  async bookingCancelled() {},
  async waitlistJoined() {},
};
