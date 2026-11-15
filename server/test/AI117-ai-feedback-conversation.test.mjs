// AI-117 — the full-answer conversation preview behind one feedback report.
//
// WHAT IS PINNED:
//   * the queue stays excerpt-only while the preview returns the reported answer in full;
//   * the preview is a bounded window around that answer, in conversation order;
//   * OWNER and ADMIN can read it, MANAGER and STAFF cannot;
//   * another business gets the same 404 as an unknown report;
//   * no email address or product id crosses the response boundary.

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

async function makePreviewThread({ businessId, userId }) {
  const conversation = await AIConversation.create({ businessId, userId, title: 'Feedback preview' });
  const total = 17;
  const targetIndex = 9;
  const messages = await AIMessage.insertMany(
    Array.from({ length: total }, (_, index) => ({
      conversationId: conversation._id,
      role: index % 2 === 0 ? 'USER' : 'ASSISTANT',
      content:
        index === targetIndex
          ? `Complete answer. ${'detailed inventory row '.repeat(100)}`
          : `message-${index}`,
      createdAt: new Date(Date.now() - (total - index) * 1000),
    })),
  );
  return { conversation, messages, target: messages[targetIndex] };
}

dbSuite('AI-117 feedback conversation preview', dbOk, () => {
  let owner;
  let admin;
  let manager;
  let staff;
  let otherOwner;
  let feedbackId;
  let target;

  before(async () => {
    owner = await registerOwner(api, tracker);
    admin = await makeRoleUser({ role: ROLES.ADMIN, businessId: owner.businessId }, tracker);
    manager = await makeRoleUser({ role: ROLES.MANAGER, businessId: owner.businessId }, tracker);
    staff = await makeRoleUser({ role: ROLES.STAFF, businessId: owner.businessId }, tracker);
    otherOwner = await registerOwner(api, tracker);

    const thread = await makePreviewThread({ businessId: owner.businessId, userId: owner.userId });
    target = thread.target;
    const submitted = await api('POST', '/api/ai/feedback', {
      token: owner.token,
      body: {
        messageId: String(target._id),
        rating: 'DOWN',
        reason: 'MISSING_INFORMATION',
        comment: 'The restock count needs a closer look.',
      },
    });
    assert.equal(submitted.status, 200);
    feedbackId = submitted.json.feedback.id;
  });

  after(async () => {
    await tracker.cleanup();
    if (server) await new Promise((resolve) => server.close(resolve));
    await disconnectDb();
  });

  it('keeps the queue excerpt-only', async () => {
    const list = await api('GET', '/api/ai/feedback', { token: owner.token });
    assert.equal(list.status, 200);
    const item = list.json.items.find((row) => row.id === feedbackId);
    assert.ok(item);
    assert.equal(item.answer.content.endsWith('…'), true);
    assert.equal(item.answer.content.length < target.content.length, true);
  });

  it('returns the complete reported answer and a bounded window to OWNER/ADMIN', async () => {
    for (const token of [owner.token, admin.token]) {
      const preview = await api('GET', `/api/ai/feedback/${feedbackId}/conversation`, { token });
      assert.equal(preview.status, 200);
      assert.equal(preview.json.feedback.status, 'OPEN');
      assert.equal(preview.json.feedback.reason, 'MISSING_INFORMATION');
      assert.equal(preview.json.feedback.reportedBy.name.length > 0, true);
      assert.equal(preview.json.messages.length, 13);
      assert.deepEqual(
        preview.json.messages.map((message) => message.content),
        Array.from({ length: 13 }, (_, index) =>
          index === 6 ? target.content : `message-${index + 3}`,
        ),
      );
      const reported = preview.json.messages.find((message) => message.reported);
      assert.ok(reported);
      assert.equal(reported.role, 'ASSISTANT');
      assert.equal(reported.content, target.content);
      assert.equal(reported.content.length > 1200, true);
      assert.equal(reported.content.endsWith('…'), false, 'the full answer is never trimmed');
      assert.equal(preview.json.omittedBefore, true);
      assert.equal(preview.json.omittedAfter, true);

      const serialized = JSON.stringify(preview.json);
      assert.equal(serialized.includes('@'), false, 'no email address crosses this read');
      assert.equal(serialized.includes('productId'), false, 'no product id crosses this read');
    }
  });

  it('denies MANAGER and STAFF, and treats another business as unknown', async () => {
    assert.equal(
      (await api('GET', `/api/ai/feedback/${feedbackId}/conversation`, { token: manager.token })).status,
      403,
    );
    assert.equal(
      (await api('GET', `/api/ai/feedback/${feedbackId}/conversation`, { token: staff.token })).status,
      403,
    );
    assert.equal(
      (await api('GET', `/api/ai/feedback/${feedbackId}/conversation`, { token: otherOwner.token })).status,
      404,
    );
    assert.equal(
      (await api('GET', '/api/ai/feedback/not-an-id/conversation', { token: owner.token })).status,
      400,
    );
    assert.equal(
      (await api('GET', '/api/ai/feedback/000000000000000000000000/conversation', {
        token: owner.token,
      })).status,
      404,
    );
  });

  it('does not expose the conversation after the report is removed', async () => {
    // A report can be deleted only by tenant teardown today, but the preview must
    // never resolve a conversation from a feedback id that no longer exists.
    await AiFeedback.deleteOne({ _id: feedbackId });
    assert.equal(
      (await api('GET', `/api/ai/feedback/${feedbackId}/conversation`, { token: owner.token })).status,
      404,
    );
  });
});
