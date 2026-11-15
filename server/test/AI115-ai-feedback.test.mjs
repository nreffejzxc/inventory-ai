// AI-115 — member ratings and the owner/admin feedback review queue.
//
// WHAT IS PINNED:
//   * a member can rate only a stored assistant answer in their own thread;
//   * a second rating updates the first rather than creating a duplicate;
//   * the thread reload carries only the caller's own rating;
//   * another business cannot see, rate, or review the feedback;
//   * OWNER/ADMIN can review, MANAGER/STAFF cannot, and review is tenant-scoped;
//   * the queue returns bounded question/answer excerpts and all-time counts.

import { it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { dbSuite } from './testEnv.mjs';
import {
  startServer,
  makeApi,
  createTracker,
  registerOwner,
  makeRoleUser,
  disconnectDb,
} from './support.mjs';
import { ROLES } from '../src/constants/roles.ts';
import AIConversation from '../src/models/aiConversation.model.ts';
import AIMessage from '../src/models/aiMessage.model.ts';
import AiFeedback from '../src/models/aiFeedback.model.ts';

const { dbOk, baseUrl, server } = await startServer();
const api = makeApi(baseUrl);
const tracker = createTracker(dbOk);

async function makeThread({ businessId, userId, suffix }) {
  const conversation = await AIConversation.create({ businessId, userId, title: `Feedback ${suffix}` });
  const question = await AIMessage.create({
    conversationId: conversation._id,
    role: 'USER',
    content: `Which products need restocking ${suffix}?`,
    createdAt: new Date(Date.now() - 2000),
  });
  const answer = await AIMessage.create({
    conversationId: conversation._id,
    role: 'ASSISTANT',
    content: 'Compact Kettle is below its minimum.',
    turnId: `turn-${suffix}`,
    toolsUsed: ['getLowStockProducts'],
    createdAt: new Date(Date.now() - 1000),
  });
  return { conversation, question, answer };
}

dbSuite('AI-115 feedback', dbOk, () => {
  let owner;
  let admin;
  let manager;
  let staff;
  let otherOwner;
  let thread;

  before(async () => {
    owner = await registerOwner(api, tracker);
    admin = await makeRoleUser({ role: ROLES.ADMIN, businessId: owner.businessId }, tracker);
    manager = await makeRoleUser({ role: ROLES.MANAGER, businessId: owner.businessId }, tracker);
    staff = await makeRoleUser({ role: ROLES.STAFF, businessId: owner.businessId }, tracker);
    otherOwner = await registerOwner(api, tracker);
    thread = await makeThread({ businessId: owner.businessId, userId: owner.userId, suffix: 'main' });
  });

  after(async () => {
    await tracker.cleanup();
    if (server) await new Promise((resolve) => server.close(resolve));
    await disconnectDb();
  });

  it('refuses a message that is not an answer in the caller’s thread', async () => {
    const unknown = await api('POST', '/api/ai/feedback', {
      token: owner.token,
      body: { messageId: 'not-an-id', rating: 'UP' },
    });
    assert.equal(unknown.status, 400);

    const noReason = await api('POST', '/api/ai/feedback', {
      token: owner.token,
      body: { messageId: String(thread.answer._id), rating: 'DOWN' },
    });
    assert.equal(noReason.status, 400, 'a DOWN rating must name a reason');
    assert.equal(await AiFeedback.countDocuments({ messageId: thread.answer._id }), 0);

    const foreign = await api('POST', '/api/ai/feedback', {
      token: otherOwner.token,
      body: { messageId: String(thread.answer._id), rating: 'DOWN', reason: 'INCORRECT_DATA' },
    });
    assert.equal(foreign.status, 404, 'another business cannot rate this answer');

    const sameBusinessOtherMember = await api('POST', '/api/ai/feedback', {
      token: admin.token,
      body: { messageId: String(thread.answer._id), rating: 'UP' },
    });
    assert.equal(sameBusinessOtherMember.status, 404, 'a colleague cannot rate someone else’s thread');
  });

  it('stores one rating, can change it, and reloads it on the owning thread', async () => {
    const down = await api('POST', '/api/ai/feedback', {
      token: owner.token,
      body: {
        messageId: String(thread.answer._id),
        rating: 'DOWN',
        reason: 'INCORRECT_DATA',
        comment: 'The quantity is wrong.',
      },
    });
    assert.equal(down.status, 200);
    assert.equal(down.json.feedback.rating, 'DOWN');
    assert.equal(down.json.feedback.reason, 'INCORRECT_DATA');
    assert.equal(down.json.feedback.status, 'OPEN');

    const changed = await api('POST', '/api/ai/feedback', {
      token: owner.token,
      body: {
        messageId: String(thread.answer._id),
        rating: 'UP',
        reason: 'OTHER',
        comment: 'This stale note must not survive an UP rating.',
      },
    });
    assert.equal(changed.status, 200);
    assert.equal(changed.json.feedback.rating, 'UP');
    assert.equal(changed.json.feedback.reason, null);
    assert.equal(changed.json.feedback.comment, null);
    assert.equal(await AiFeedback.countDocuments({ messageId: thread.answer._id }), 1);

    const messages = await api(
      'GET',
      `/api/ai/conversations/${thread.conversation._id}/messages`,
      { token: owner.token },
    );
    assert.equal(messages.status, 200);
    assert.equal(
      messages.json.items.find((message) => message.id === String(thread.answer._id)).feedback.rating,
      'UP',
    );
  });

  it('is reviewable by OWNER and ADMIN only, with tenant isolation', async () => {
    const denied = await api('GET', '/api/ai/feedback', { token: manager.token });
    assert.equal(denied.status, 403);
    assert.equal((await api('GET', '/api/ai/feedback', { token: staff.token })).status, 403);

    const list = await api('GET', '/api/ai/feedback', { token: admin.token });
    assert.equal(list.status, 200);
    assert.ok(list.json.items.length >= 1);
    assert.equal(list.json.summary.open, 1);
    assert.equal(list.json.items[0].question.content, 'Which products need restocking main?');
    assert.match(list.json.items[0].answer.content, /Compact Kettle/);
    assert.equal(list.json.items[0].reportedBy.name.length > 0, true);

    const other = await api('GET', '/api/ai/feedback', { token: otherOwner.token });
    assert.equal(other.status, 200);
    assert.equal(other.json.items.length, 0);

    const feedbackId = list.json.items[0].id;
    const crossTenant = await api('PATCH', `/api/ai/feedback/${feedbackId}`, {
      token: otherOwner.token,
      body: { reviewed: true },
    });
    assert.equal(crossTenant.status, 404);

    const reviewed = await api('PATCH', `/api/ai/feedback/${feedbackId}`, {
      token: admin.token,
      body: { reviewed: true },
    });
    assert.equal(reviewed.status, 200);
    assert.equal(reviewed.json.feedback.status, 'REVIEWED');

    const reopened = await api('PATCH', `/api/ai/feedback/${feedbackId}`, {
      token: admin.token,
      body: { reviewed: false },
    });
    assert.equal(reopened.status, 200);
    assert.equal(reopened.json.feedback.status, 'OPEN');
  });
});