import type { Resolution, Status } from './types.js';
import { RESOLUTIONS } from './types.js';

// The lifecycle, drawn as a graph. Reopening is a first-class edge from every
// terminal-ish state back to `confirmed` (never back to `unconfirmed`: once a
// bug has been reproduced by the team, that knowledge is not un-learnable).
//
//  unconfirmed ──▶ confirmed ──▶ in_progress ──▶ in_review
//        │            │  ▲            │  ▲          │
//        │            │  └────────────┘  └──────────┤
//        ▼            ▼                              ▼
//     resolved ◀──────┴──────────────────────────────┘
//        │  ▲
//        ▼  │ (reopen ⇒ back to confirmed, resolution cleared)
//     verified ──▶ closed
//
export const TRANSITIONS: Record<Status, Status[]> = {
  unconfirmed: ['confirmed', 'resolved'],
  confirmed: ['in_progress', 'resolved'],
  in_progress: ['in_review', 'confirmed', 'resolved'],
  in_review: ['in_progress', 'resolved'],
  resolved: ['verified', 'confirmed'],
  verified: ['closed', 'confirmed'],
  closed: ['confirmed'],
};

export const RESOLVED_STATES: Status[] = ['resolved', 'verified', 'closed'];

export interface TransitionInput {
  from: Status;
  to: Status;
  resolution?: Resolution | null;
  assigneeId?: number | null;
  duplicateOfKey?: string | null;
}

export interface TransitionError {
  code: string;
  message: string;
  legalNextStates: Status[];
}

/**
 * Validate a status transition. Returns null when legal, or a structured
 * error naming the legal next states. This runs server-side on every
 * transition — the UI merely mirrors it.
 */
export function validateTransition(input: TransitionInput): TransitionError | null {
  const { from, to } = input;
  const legal = TRANSITIONS[from];

  if (from === to) {
    return {
      code: 'noop_transition',
      message: `Issue is already ${from}. Legal next states: ${legal.join(', ')}.`,
      legalNextStates: legal,
    };
  }

  if (!legal.includes(to)) {
    return {
      code: 'illegal_transition',
      message: `Cannot move from ${from} to ${to}. Legal next states: ${legal.join(', ')}.`,
      legalNextStates: legal,
    };
  }

  if (to === 'resolved') {
    if (!input.resolution) {
      return {
        code: 'resolution_required',
        message: `Resolving requires a resolution (${RESOLUTIONS.join(', ')}) — a bug never just stops, it stops for a reason.`,
        legalNextStates: legal,
      };
    }
    if (!RESOLUTIONS.includes(input.resolution)) {
      return {
        code: 'invalid_resolution',
        message: `Unknown resolution "${input.resolution}". Valid: ${RESOLUTIONS.join(', ')}.`,
        legalNextStates: legal,
      };
    }
    if (input.resolution === 'duplicate' && !input.duplicateOfKey) {
      return {
        code: 'duplicate_target_required',
        message: 'Resolving as duplicate requires the key of the canonical issue (duplicateOf).',
        legalNextStates: legal,
      };
    }
  }

  if (to === 'in_progress' && input.assigneeId == null) {
    return {
      code: 'assignee_required',
      message: 'An issue cannot be in progress with no one working on it — assign it first (or pass assigneeId with the transition).',
      legalNextStates: legal,
    };
  }

  return null;
}

/** Reopening = any move out of a resolved-family state back to confirmed. */
export function isReopen(from: Status, to: Status): boolean {
  return RESOLVED_STATES.includes(from) && to === 'confirmed';
}
