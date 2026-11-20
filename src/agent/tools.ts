import type { ConversationState, OfferedSlot } from '../db/repo.js';
import { activeBookedSlotIds, createHandoff } from '../db/repo.js';
import type { LabClient, LabSlot } from '../lab/client.js';
import { LabError } from '../lab/client.js';
import { isTestId, istDate, TESTS, testName } from '../lab/tests.js';
import type { BookingService } from '../booking/service.js';
import { log } from '../util/log.js';
import type { ToolDef } from '../llm/types.js';

export const TOOL_DEFS: ToolDef[] = [
  {
    name: 'check_slots',
    description: 'List the next available lab slots for a test. Call this before offering slots.',
    parameters: {
      type: 'object',
      properties: {
        test_id: {
          type: 'string',
          enum: TESTS.map((t) => t.id),
          description: 'The lab test identifier.',
        },
        date: {
          type: 'string',
          description: 'Optional date in YYYY-MM-DD. Defaults to tomorrow.',
        },
      },
      required: ['test_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'book_test',
    description:
      'Book a previously offered slot. Fails if the slot was not offered or is no longer available.',
    parameters: {
      type: 'object',
      properties: {
        slot_id: { type: 'string', description: 'Exact slot_id from check_slots.' },
        patient_name: { type: 'string', description: 'Patient name if the patient gave it.' },
      },
      required: ['slot_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'handoff_to_human',
    description: 'Stop automation and hand the conversation to a lab colleague.',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Short reason for the handoff.' },
      },
      required: ['reason'],
      additionalProperties: false,
    },
  },
];

export interface ToolContext {
  conversationId: string;
  state: ConversationState;
  lab: LabClient;
  booking: BookingService;
  /** The patient's current message, used for explicit-choice guards. */
  userText: string;
}

/** True when the patient actually chose a slot in this message. */
function hasExplicitChoice(text: string, offered: OfferedSlot[]): boolean {
  // "2027-01-19" contains digits but is not a choice.
  const cleaned = text.replace(/\d{4}-\d{2}-\d{2}/g, ' ');
  if (/\b([1-9])\b/.test(cleaned)) return true;
  if (/\b(first|second|third|fourth|fifth|sixth)\b/i.test(cleaned)) return true;
  return offered.some((slot) => text.includes(slot.slot_id));
}

export interface ToolOutcome {
  data: Record<string, unknown>;
  statePatch?: Partial<ConversationState>;
  handoff?: boolean;
}

function toOffered(slots: LabSlot[]): OfferedSlot[] {
  return slots
    .filter((s) => s.available !== false)
    .slice(0, 6)
    .map((s) => ({ slot_id: s.slot_id, label: s.label, ...(s.start_at ? { start_at: s.start_at } : {}) }));
}

async function fetchSlots(
  lab: LabClient,
  testId: string,
  date: string,
): Promise<{ offered: OfferedSlot[]; error?: string }> {
  try {
    const [slots, reserved] = await Promise.all([
      lab.checkSlots(testId, date),
      activeBookedSlotIds(`${testId}-${date}-`),
    ]);
    // Our own reservation wins over a stale lab availability feed.
    return { offered: toOffered(slots).filter((s) => !reserved.has(s.slot_id)) };
  } catch (err) {
    log.warn('check_slots failed', { error: (err as Error).message });
    return { offered: [], error: err instanceof LabError ? err.kind : 'unknown' };
  }
}

/**
 * Every tool validates its arguments against conversation state. The model
 * cannot invent a slot id, book an unoffered slot, or book twice.
 */
export async function runTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  switch (name) {
    case 'check_slots': {
      // Models occasionally return "CBC"; normalise before validating.
      const testId =
        typeof args.test_id === 'string' ? args.test_id.trim().toLowerCase() : '';
      if (!isTestId(testId)) {
        return {
          data: {
            ok: false,
            error: 'UNKNOWN_TEST',
            supported: TESTS.map((t) => t.id),
          },
        };
      }
      const date =
        typeof args.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(args.date)
          ? args.date
          : istDate(1);
      const { offered, error } = await fetchSlots(ctx.lab, testId, date);
      if (error) {
        return { data: { ok: false, error: 'LAB_UNAVAILABLE', retryable: true } };
      }
      if (offered.length === 0) {
        return { data: { ok: false, error: 'NO_SLOTS', date } };
      }
      return {
        data: {
          ok: true,
          test_id: testId,
          test_name: testName(testId),
          date,
          slots: offered.map((s) => ({ slot_id: s.slot_id, label: s.label })),
        },
        statePatch: { test_id: testId, date, offered_slots: offered },
      };
    }

    case 'book_test': {
      const slotId = typeof args.slot_id === 'string' ? args.slot_id : '';
      const testId = ctx.state.test_id;
      if (!testId || !isTestId(testId)) {
        return { data: { ok: false, error: 'NO_TEST_SELECTED' } };
      }
      if (ctx.state.booking?.status === 'confirmed') {
        return {
          data: {
            ok: true,
            already_booked: true,
            slot_id: ctx.state.booking.slot_id,
            booking_id: ctx.state.booking.lab_booking_id ?? ctx.state.booking.id,
          },
        };
      }
      const offered = ctx.state.offered_slots ?? [];
      const chosen = offered.find((s) => s.slot_id === slotId);
      if (!chosen) {
        return {
          data: {
            ok: false,
            error: 'SLOT_NOT_OFFERED',
            message: 'Choose a slot that was offered in this conversation.',
            slots: offered.map((s) => ({ slot_id: s.slot_id, label: s.label })),
          },
        };
      }

      // Deterministic guard: the model may propose a booking, but only an
      // explicit choice from the patient can create one.
      if (!hasExplicitChoice(ctx.userText, offered)) {
        return {
          data: {
            ok: false,
            error: 'NEEDS_EXPLICIT_CHOICE',
            message: 'Ask the patient to pick a slot before booking.',
            slots: offered.map((s) => ({ slot_id: s.slot_id, label: s.label })),
          },
        };
      }

      const patientName =
        typeof args.patient_name === 'string' && args.patient_name.trim()
          ? args.patient_name.trim().slice(0, 80)
          : (ctx.state.patient_name ?? 'WhatsApp Patient');

      const result = await ctx.booking.book({
        conversationId: ctx.conversationId,
        testId,
        slotId,
        patientName,
      });

      if (result.ok) {
        // The DB is the source of truth: report the slot that is actually booked.
        const bookedSlot = result.booking.slot_id;
        const bookedLabel =
          offered.find((s) => s.slot_id === bookedSlot)?.label ?? chosen.label;
        return {
          data: {
            ok: true,
            status: 'CONFIRMED',
            slot_id: bookedSlot,
            slot_label: bookedLabel,
            test_id: result.booking.test_id,
            test_name: testName(result.booking.test_id),
            booking_id: result.booking.lab_booking_id ?? result.booking.id,
            cached: result.cached,
            reconciled: result.reconciled,
          },
          statePatch: {
            patient_name: patientName,
            selected_slot: bookedSlot,
            booking: {
              id: result.booking.id,
              status: 'confirmed',
              lab_booking_id: result.booking.lab_booking_id,
              slot_id: bookedSlot,
            },
          },
        };
      }

      if (result.code === 'SLOT_TAKEN') {
        const date = ctx.state.date ?? istDate(1);
        const { offered: fresh } = await fetchSlots(ctx.lab, testId, date);
        return {
          data: {
            ok: false,
            error: 'SLOT_TAKEN',
            message: 'Another patient took that slot. Offer the remaining slots.',
            slots: fresh.map((s) => ({ slot_id: s.slot_id, label: s.label })),
          },
          statePatch: fresh.length ? { offered_slots: fresh } : {},
        };
      }

      return {
        data: {
          ok: false,
          error: 'LAB_UNAVAILABLE',
          retryable: true,
          message: 'The lab API is unavailable. Do not promise a booking yet.',
        },
      };
    }

    case 'handoff_to_human': {
      const reason =
        typeof args.reason === 'string' && args.reason.trim()
          ? args.reason.trim().slice(0, 300)
          : 'patient requested a human';
      await createHandoff({ conversationId: ctx.conversationId, reason, source: 'agent' });
      return { data: { ok: true, handoff: true, reason }, handoff: true };
    }

    default:
      return { data: { ok: false, error: 'UNKNOWN_TOOL', tool: name } };
  }
}
