import type { LabClient } from '../lab/client.js';
import { LabError } from '../lab/client.js';
import { bookingIdempotencyKey } from '../util/ids.js';
import { log } from '../util/log.js';
import {
  confirmBooking,
  failBooking,
  findActiveBookingByKey,
  findActiveBookingBySlot,
  findActiveBookingForConversation,
  noteBookingError,
  reserveBooking,
  type BookingRow,
} from '../db/repo.js';

export interface BookInput {
  conversationId: string;
  testId: string;
  slotId: string;
  patientName?: string | null;
}

export type BookResult =
  | { ok: true; booking: BookingRow; cached: boolean; reconciled: boolean }
  | {
      ok: false;
      code: 'SLOT_TAKEN' | 'LAB_UNAVAILABLE';
      message: string;
      booking?: BookingRow;
    };

/**
 * Two-phase booking:
 *   1. reserve the slot in OUR database (partial unique index decides the winner)
 *   2. call the lab with a deterministic Idempotency-Key
 *
 * The reservation is deliberately kept when the lab outcome is ambiguous.
 * Releasing a slot that the lab may have committed is the only way to
 * double-book, so the safe default is to hold it and let a human reconcile.
 */
export class BookingService {
  constructor(private readonly lab: LabClient) {}

  async book(input: BookInput): Promise<BookResult> {
    const key = bookingIdempotencyKey(input.conversationId, input.slotId, input.testId);

    let booking = await findActiveBookingByKey(key);
    if (booking?.status === 'confirmed') {
      return { ok: true, booking, cached: true, reconciled: false };
    }

    if (!booking) {
      const reserved = await reserveBooking({
        conversationId: input.conversationId,
        testId: input.testId,
        slotId: input.slotId,
        patientName: input.patientName ?? null,
        idempotencyKey: key,
      });

      if (reserved) {
        booking = reserved;
      } else {
        booking = await findActiveBookingByKey(key);
      }

      if (!booking) {
        const byConversation = await findActiveBookingForConversation(input.conversationId);
        if (byConversation) {
          // The conversation already holds a slot. Treat as idempotent success;
          // the agent will report the existing booking.
          return { ok: true, booking: byConversation, cached: true, reconciled: false };
        }
        const bySlot = await findActiveBookingBySlot(input.slotId);
        if (bySlot) {
          return {
            ok: false,
            code: 'SLOT_TAKEN',
            message: 'That slot was taken a moment ago.',
          };
        }
        return {
          ok: false,
          code: 'LAB_UNAVAILABLE',
          message: 'The booking service is temporarily unavailable.',
        };
      }
    }

    try {
      const labBooking = await this.lab.createBooking(
        {
          slot_id: input.slotId,
          test_id: input.testId,
          patient_name: input.patientName ?? 'WhatsApp Patient',
        },
        key,
      );
      const confirmed = await confirmBooking(booking.id, labBooking.booking_id);
      return { ok: true, booking: confirmed ?? booking, cached: false, reconciled: false };
    } catch (err) {
      if (err instanceof LabError && err.kind === 'slot_taken') {
        await failBooking(booking.id, 'slot_taken');
        return { ok: false, code: 'SLOT_TAKEN', message: 'That slot was taken a moment ago.' };
      }

      // Ambiguous: the lab may have committed before the response was lost.
      const existing = await this.lab.findBookingByKey(key);
      if (existing) {
        const confirmed = await confirmBooking(booking.id, existing.booking_id);
        log.info('booking reconciled via idempotency key', { bookingId: booking.id });
        return { ok: true, booking: confirmed ?? booking, cached: false, reconciled: true };
      }

      await noteBookingError(booking.id, (err as Error).message);
      log.warn('lab booking failed; reservation kept for retry', {
        bookingId: booking.id,
        error: (err as Error).message,
      });
      return {
        ok: false,
        code: 'LAB_UNAVAILABLE',
        message: 'The lab is having trouble right now. Your slot is held; we will retry.',
      };
    }
  }
}
