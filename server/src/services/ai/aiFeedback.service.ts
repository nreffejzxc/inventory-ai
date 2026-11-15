/**
 * AI-115 — member ratings and the owner/admin review queue.
 *
 * The assistant already stores every answer, its turn id and the tools that
 * produced it. This module adds the missing human signal: whether the member who
 * read the answer found it useful, and — when they did not — what went wrong.
 *
 * DATA MINIMISATION. A feedback row stores the member's rating, one optional
 * category, an optional note and the owning ids. The review read joins the
 * question and answer it refers to, but returns only a bounded excerpt of each;
 * an owner/admin cannot use this endpoint to page through somebody else's whole
 * conversation. The member's email address is never returned; the name is enough
 * to follow up inside the business.
 */

import mongoose from 'mongoose';

import AiFeedback from '../../models/aiFeedback.model.ts';
import AIMessage from '../../models/aiMessage.model.ts';
import AIConversation from '../../models/aiConversation.model.ts';
import User from '../../models/user.model.ts';
import { notFound } from '../../utils/errors.ts';

export const AI_FEEDBACK_REASONS = Object.freeze({
  INCORRECT_DATA: 'INCORRECT_DATA',
  MISSING_INFORMATION: 'MISSING_INFORMATION',
  HARD_TO_UNDERSTAND: 'HARD_TO_UNDERSTAND',
  OTHER: 'OTHER',
});

export type AiFeedbackReason = (typeof AI_FEEDBACK_REASONS)[keyof typeof AI_FEEDBACK_REASONS];

export const AI_FEEDBACK_REASON_VALUES: readonly string[] = Object.freeze(
  Object.values(AI_FEEDBACK_REASONS),
);

/** The member-facing shape attached to an assistant message on a thread reload. */
export interface MemberFeedback {
  id: string;
  rating: 'UP' | 'DOWN';
  reason: string | null;
  comment: string | null;
  status: 'OPEN' | 'REVIEWED';
  createdAt: Date;
  updatedAt: Date;
}

type FeedbackDoc = mongoose.HydratedDocFromModel<typeof AiFeedback>;

function excerpt(value: string | null | undefined, max: number): string | null {
  if (!value) return null;
  const text = value.trim();
  if (!text) return null;
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function memberFeedback(doc: FeedbackDoc): MemberFeedback {
  return {
    id: String(doc._id),
    rating: doc.rating,
    reason: doc.reason || null,
    comment: doc.comment || null,
    status: doc.status,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/**
 * The ratings that belong to the assistant messages in one loaded page.
 *
 * Scoped twice: by the caller's business and by the caller's own user id. A
 * second member of the same business therefore never sees the first member's
 * rating, even if they somehow obtain the message id.
 */
export async function feedbackForMessages(
  businessId: string,
  userId: string,
  messageIds: Array<string | mongoose.Types.ObjectId>,
): Promise<Map<string, MemberFeedback>> {
  if (!messageIds.length) return new Map();
  const rows = await AiFeedback.find({
    businessId,
    userId,
    messageId: { $in: messageIds },
  }).lean();
  return new Map(rows.map((row) => [String(row.messageId), memberFeedback(row as FeedbackDoc)]));
}

/**
 * Create or replace one member's rating of one answer.
 *
 * The answer is resolved first, then its conversation is checked for the SAME
 * business and user. That ordering is what makes a guessed message id a 404
 * rather than a way to rate somebody else's answer.
 */
export async function submitFeedback({
  businessId,
  userId,
  messageId,
  rating,
  reason,
  comment,
}: {
  businessId: string;
  userId: string;
  messageId: string;
  rating: 'UP' | 'DOWN';
  reason?: string;
  comment?: string;
}): Promise<MemberFeedback> {
  const message = await AIMessage.findOne({ _id: messageId, role: 'ASSISTANT' });
  if (!message) notFound('Answer not found');
  const conversation = await AIConversation.exists({
    _id: message.conversationId,
    businessId,
    userId,
  });
  if (!conversation) notFound('Answer not found');

  const doc = await AiFeedback.findOneAndUpdate(
    { businessId, messageId: message._id, userId },
    {
      $set: {
        conversationId: message.conversationId,
        rating,
        // A reason explains a DOWN rating. An UP rating cannot carry one, even
        // if a hand-built request sends it, so the stored shape stays honest.
        reason: rating === 'DOWN' ? reason || null : null,
        comment: rating === 'DOWN' ? comment || null : null,
        turnId: message.turnId || null,
        status: 'OPEN',
        reviewedBy: null,
        reviewedAt: null,
      },
      $setOnInsert: { businessId, messageId: message._id, userId },
    },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
  );
  return memberFeedback(doc as FeedbackDoc);
}

/** One review item: enough to understand the report without exposing the thread. */
export interface ReviewFeedbackItem {
  id: string;
  rating: 'UP' | 'DOWN';
  reason: string | null;
  comment: string | null;
  status: 'OPEN' | 'REVIEWED';
  createdAt: Date;
  reviewedAt: Date | null;
  turnId: string | null;
  messageId: string;
  conversationId: string;
  reportedBy: { id: string; name: string; role: string } | null;
  question: { content: string; createdAt: Date } | null;
  answer: { content: string; createdAt: Date; toolsUsed: string[] } | null;
}

/**
 * The owner/admin review page.
 *
 * Pagination is applied to feedback rows, and the joined question/answer are read
 * per row. That is deliberately bounded by the page size (20 by default, 100 at
 * the HTTP cap); a conversation is not scanned in full just to render a report.
 */
export async function listFeedback(
  businessId: string,
  {
    limit,
    skip,
    status,
    rating,
  }: {
    page: number;
    limit: number;
    skip: number;
    status?: 'OPEN' | 'REVIEWED';
    rating?: 'UP' | 'DOWN';
  },
): Promise<{
  items: ReviewFeedbackItem[];
  total: number;
  summary: { total: number; open: number; up: number; down: number };
}> {
  const filter: Record<string, unknown> = { businessId };
  if (status) filter.status = status;
  if (rating) filter.rating = rating;

  const [total, docs, summaryTotal, summaryOpen, summaryUp, summaryDown] = await Promise.all([
    AiFeedback.countDocuments(filter),
    AiFeedback.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(),
    AiFeedback.countDocuments({ businessId }),
    AiFeedback.countDocuments({ businessId, status: 'OPEN' }),
    AiFeedback.countDocuments({ businessId, rating: 'UP' }),
    AiFeedback.countDocuments({ businessId, rating: 'DOWN' }),
  ]);

  const messageIds = docs.map((row) => row.messageId);
  const userIds = docs.map((row) => row.userId);
  const [messages, users] = await Promise.all([
    AIMessage.find({ _id: { $in: messageIds } })
      .select('_id conversationId content createdAt toolsUsed')
      .lean(),
    User.find({ _id: { $in: userIds }, businessId }).select('_id name role').lean(),
  ]);
  const messageById = new Map(messages.map((message) => [String(message._id), message]));
  const userById = new Map(users.map((user) => [String(user._id), user]));

  const items = await Promise.all(
    docs.map(async (row) => {
      const message = messageById.get(String(row.messageId));
      const user = userById.get(String(row.userId));
      const question = message
        ? await AIMessage.findOne({
            conversationId: message.conversationId,
            role: 'USER',
            createdAt: { $lte: message.createdAt },
          })
            .sort({ createdAt: -1, _id: -1 })
            .select('content createdAt')
            .lean()
        : null;

      return {
        id: String(row._id),
        rating: row.rating,
        reason: row.reason || null,
        comment: row.comment || null,
        status: row.status,
        createdAt: row.createdAt,
        reviewedAt: row.reviewedAt || null,
        turnId: row.turnId || null,
        messageId: String(row.messageId),
        conversationId: String(row.conversationId),
        reportedBy: user
          ? { id: String(user._id), name: user.name, role: user.role }
          : null,
        question: question
          ? { content: excerpt(question.content, 500) as string, createdAt: question.createdAt }
          : null,
        answer: message
          ? {
              content: excerpt(message.content, 1200) as string,
              createdAt: message.createdAt,
              toolsUsed: message.toolsUsed ?? [],
            }
          : null,
      };
    }),
  );

  return {
    items,
    total,
    summary: { total: summaryTotal, open: summaryOpen, up: summaryUp, down: summaryDown },
  };
}

/** Mark one report read, or reopen it. Scoped to the caller's business. */
export async function reviewFeedback({
  businessId,
  feedbackId,
  reviewerId,
  reviewed,
}: {
  businessId: string;
  feedbackId: string;
  reviewerId: string;
  reviewed: boolean;
}): Promise<FeedbackDoc> {
  const doc = await AiFeedback.findOneAndUpdate(
    { _id: feedbackId, businessId },
    {
      $set: reviewed
        ? { status: 'REVIEWED', reviewedBy: reviewerId, reviewedAt: new Date() }
        : { status: 'OPEN', reviewedBy: null, reviewedAt: null },
    },
    { returnDocument: 'after' },
  );
  if (!doc) notFound('Feedback not found');
  return doc as FeedbackDoc;
}

export default {
  AI_FEEDBACK_REASONS,
  AI_FEEDBACK_REASON_VALUES,
  feedbackForMessages,
  submitFeedback,
  listFeedback,
  reviewFeedback,
};