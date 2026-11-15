/**
 * AI-115 — the vocabulary shared by the rating form and the owner/admin queue.
 *
 * These values are the server's stored enum. The labels are deliberately plain
 * operational language: a warehouse member should not have to interpret
 * "hallucination" or "grounding failure" to report a wrong quantity.
 */

export type FeedbackRating = 'UP' | 'DOWN';

export type FeedbackReason =
  | 'INCORRECT_DATA'
  | 'MISSING_INFORMATION'
  | 'HARD_TO_UNDERSTAND'
  | 'OTHER';

export interface FeedbackReasonOption {
  value: FeedbackReason;
  label: string;
}

export const FEEDBACK_REASONS: readonly FeedbackReasonOption[] = Object.freeze([
  { value: 'INCORRECT_DATA', label: 'Incorrect data' },
  { value: 'MISSING_INFORMATION', label: 'Missing information' },
  { value: 'HARD_TO_UNDERSTAND', label: 'Hard to understand' },
  { value: 'OTHER', label: 'Something else' },
]);

export function feedbackReasonLabel(value: string | null | undefined): string | null {
  return FEEDBACK_REASONS.find((reason) => reason.value === value)?.label ?? null;
}

export function isFeedbackReason(value: unknown): value is FeedbackReason {
  return typeof value === 'string' && FEEDBACK_REASONS.some((reason) => reason.value === value);
}

/** A stored rating as the thread reloads it. */
export interface AnswerFeedback {
  id: string;
  rating: FeedbackRating;
  reason?: string | null;
  comment?: string | null;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
}

/** The actionable reasons a reviewer can show for a DOWN rating. */
export function feedbackSummary(reason: string | null | undefined, comment: string | null | undefined): string {
  const label = feedbackReasonLabel(reason);
  if (label && comment) return `${label} — ${comment}`;
  return label || comment || 'No reason provided';
}