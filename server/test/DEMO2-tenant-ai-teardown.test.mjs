// DEMO-2 — a tenant teardown removes everything that belongs to the tenant.
//
// Found on 2026-10-23 while deleting a production demo tenant after a device run:
// `clearTenantData` covered inventory, products, categories, locations, suppliers and
// purchase orders, but not `ai_conversations` / `ai_messages`. The teardown printed
// "leftovers: 0 — verified over every tenant collection" while three conversations and
// eight messages from the run stayed behind. Auditing the same list against the models
// then found two more gaps: `audit_logs` (which carries businessId) and the
// account-scoped rows a tenant owns indirectly — `sessions`, `password_reset_tokens`
// and `password_reset_challenges` (each carries only `userId`).
//
// Why these need more than another row in TENANT_DATA_COLLECTIONS:
//   * a MESSAGE has no businessId — it points at its conversation, so conversations
//     must be resolved first and messages deleted by `conversationId`;
//   * sessions and reset credentials have no businessId either, so the whole tenant's
//     user ids must be resolved before the users are deleted.

import { it, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import { dbSuite } from './testEnv.mjs';
import { ensureDb, disconnectDb } from './helpers.mjs';
import AuditLog from '../src/models/auditLog.model.ts';
import Business from '../src/models/business.model.ts';
import Category from '../src/models/category.model.ts';
import Inventory from '../src/models/inventory.model.ts';
import InventoryTransaction from '../src/models/inventoryTransaction.model.ts';
import Invitation from '../src/models/invitation.model.ts';
import Location from '../src/models/location.model.ts';
import PasswordResetChallenge from '../src/models/passwordResetChallenge.model.ts';
import PasswordResetToken from '../src/models/passwordResetToken.model.ts';
import Product from '../src/models/product.model.ts';
import PurchaseOrder from '../src/models/purchaseOrder.model.ts';
import Session from '../src/models/session.model.ts';
import Supplier from '../src/models/supplier.model.ts';
import User from '../src/models/user.model.ts';
import AIConversation from '../src/models/aiConversation.model.ts';
import AIMessage from '../src/models/aiMessage.model.ts';
import AiTurnMetric from '../src/models/aiTurnMetric.model.ts';
import { formatCollectionCounts } from '../scripts/cleanup/lib.mjs';
import {
  clearTenantData,
  countTenantDataRemoval,
  countTenantLeftovers,
  countTenantRemoval,
  removeTenant,
} from '../scripts/perf/lib.mjs';

const oid = () => new mongoose.Types.ObjectId();
const targetBusiness = oid();
const keeperBusiness = oid();
const targetUser = oid();
const keeperUser = oid();

const TARGET_EMAIL = 'demo2-target@example.invalid';
const KEEPER_EMAIL = 'demo2-keeper@example.invalid';
const TARGET_NAME = 'DEMO2 Teardown Target';
const KEEPER_NAME = 'DEMO2 Teardown Keeper';

/**
 * Seed one row set in EVERY collection the data-only cleanup plan measures, with a
 * DISTINCT count per collection.
 *
 * Distinct counts are the point. With equal counts, a preview that paired a count with
 * the wrong collection would still add up to the same total, so the test could not fail
 * for the defect it exists to catch.
 */
async function seedEveryCleanupCollection(businessId, userId) {
  const locations = await Location.insertMany(
    Array.from({ length: 9 }, (_, i) => ({ businessId, name: `PREVIEW location ${i}` })),
  );
  const suppliers = await Supplier.insertMany(
    Array.from({ length: 10 }, (_, i) => ({ businessId, name: `PREVIEW supplier ${i}` })),
  );
  await Category.insertMany(
    Array.from({ length: 8 }, (_, i) => ({ businessId, name: `PREVIEW category ${i}` })),
  );
  const products = await Product.insertMany(
    Array.from({ length: 4 }, (_, i) => ({ businessId, name: `PREVIEW product ${i}` })),
  );

  await Inventory.insertMany(
    Array.from({ length: 5 }, (_, i) => ({
      businessId,
      productId: products[i % products.length]._id,
      locationId: locations[i]._id,
      quantity: 10 + i,
    })),
  );
  await InventoryTransaction.insertMany(
    Array.from({ length: 2 }, (_, i) => ({
      businessId,
      productId: products[i]._id,
      locationId: locations[i]._id,
      type: 'STOCK_IN',
      quantity: 5,
      previousQuantity: 0,
      newQuantity: 5,
      userId,
    })),
  );
  await PurchaseOrder.insertMany(
    Array.from({ length: 6 }, (_, i) => ({
      businessId,
      number: `PREVIEW-${i + 1}`,
      supplierId: suppliers[0]._id,
      locationId: locations[0]._id,
      status: 'DRAFT',
    })),
  );

  const conversations = await AIConversation.insertMany(
    Array.from({ length: 3 }, (_, i) => ({ businessId, userId, title: `PREVIEW conversation ${i}` })),
  );
  await AIMessage.insertMany(
    Array.from({ length: 7 }, (_, i) => ({
      conversationId: conversations[i % conversations.length]._id,
      role: i % 2 === 0 ? 'USER' : 'ASSISTANT',
      content: `PREVIEW message ${i}`,
    })),
  );
  await AuditLog.insertMany(
    Array.from({ length: 11 }, (_, i) => ({
      businessId,
      action: 'PRODUCT_CREATED',
      entityType: 'PRODUCT',
      entityId: String(products[i % products.length]._id),
    })),
  );
  await Invitation.create({
    businessId,
    email: 'preview-invitee@example.invalid',
    role: 'STAFF',
    tokenHash: `preview-invitation-${String(businessId)}`,
    invitedBy: userId,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });
  await AiTurnMetric.insertMany(
    Array.from({ length: 12 }, (_, i) => ({
      businessId,
      userId,
      turnId: `preview-metric-${i}`,
      startedAt: new Date(Date.now() - (i + 1) * 1000),
      completedAt: new Date(Date.now() - i * 1000),
      outcome: 'ok',
      status: 'ok',
      route: 'default',
      model: 'preview/free:free',
      tier: 'free',
      durationMs: 1000 + i,
      providerMs: 900,
      toolMs: 100,
      calls: 1,
      emptyResponses: 0,
      retries: 0,
      failovers: 0,
      reasks: 0,
      escalations: 0,
      iterations: 1,
      toolRuns: 0,
      tools: [],
      inputTokens: 10,
      outputTokens: 5,
      providerCostUsd: 0,
      providerCostComplete: true,
      unknownCostCalls: 0,
      costStatus: 'provider',
      quota: 'unknown',
      web: 'none',
    })),
  );

  return {
    ai_messages: 7,
    ai_conversations: 3,
    inventory: 5,
    inventory_transactions: 2,
    purchase_orders: 6,
    products: 4,
    categories: 8,
    locations: 9,
    suppliers: 10,
    audit_logs: 11,
    invitations: 1,
    ai_turn_metrics: 12,
  };
}

/** Read the preview exactly as an operator reads it: one name/count line per collection. */
function parsePreview(lines) {
  const counts = {};
  for (const line of lines) {
    const match = /^ {2}([a-z_]+)\s+([\d,]+)$/.exec(line);
    assert.ok(match, `not a collection/count line: ${JSON.stringify(line)}`);
    counts[match[1]] = Number(match[2].replaceAll(',', ''));
  }
  return counts;
}

async function seedTenant(businessId, userId, productName) {
  const conversation = await AIConversation.create({ businessId, userId, title: `conv ${productName}` });
  const messages = await AIMessage.create([
    { conversationId: conversation._id, role: 'USER', content: 'how much stock do we hold?' },
    { conversationId: conversation._id, role: 'ASSISTANT', content: '112 units.', model: 'test-model' },
  ]);
  const product = await Product.create({
    businessId,
    name: productName,
    sku: `DEMO2-${String(productName).slice(0, 6)}`,
    unit: 'unit',
    costPrice: 1,
    sellingPrice: 2,
  });
  return { conversation, messages, product };
}

/** A whole tenant: business, one user, a session and one of each reset artefact. */
async function seedAccount(businessId, userId, email, name) {
  const business = await Business.create({ _id: businessId, name });
  const user = await User.create({
    _id: userId,
    businessId: business._id,
    name,
    email,
    role: 'OWNER',
    status: 'ACTIVE',
  });
  const session = await Session.create({
    userId: user._id,
    jti: `demo2-${String(user._id)}`,
    expiresAt: new Date(Date.now() + 60_000),
  });
  const token = await PasswordResetToken.create({
    userId: user._id,
    tokenHash: `demo2-token-${String(user._id)}`,
    expiresAt: new Date(Date.now() + 60_000),
  });
  const challenge = await PasswordResetChallenge.create({
    emailHmac: `demo2-email-${String(user._id)}`,
    userId: user._id,
    codeHmac: `demo2-code-${String(user._id)}`,
    lastSentAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
    attempts: 0,
  });
  return { business, user, session, token, challenge };
}

/** Remove every row these tests could have written, so a re-run starts clean. */
async function resetDemo2() {
  const users = await User.find({ email: { $in: [TARGET_EMAIL, KEEPER_EMAIL] } })
    .select('_id businessId')
    .lean();
  const userIds = users.map((u) => u._id);
  const businessIds = [targetBusiness, keeperBusiness, ...users.map((u) => u.businessId).filter(Boolean)];

  const conversations = await AIConversation.find({ businessId: { $in: businessIds } })
    .select('_id')
    .lean();

  await Promise.all([
    Session.deleteMany({ userId: { $in: userIds } }),
    PasswordResetToken.deleteMany({ userId: { $in: userIds } }),
    PasswordResetChallenge.deleteMany({ userId: { $in: userIds } }),
    User.deleteMany({ _id: { $in: userIds } }),
    Business.deleteMany({ _id: { $in: businessIds } }),
    Product.deleteMany({ businessId: { $in: businessIds } }),
    AuditLog.deleteMany({ businessId: { $in: businessIds } }),
    Category.deleteMany({ businessId: { $in: businessIds } }),
    Inventory.deleteMany({ businessId: { $in: businessIds } }),
    InventoryTransaction.deleteMany({ businessId: { $in: businessIds } }),
    Invitation.deleteMany({ businessId: { $in: businessIds } }),
    Location.deleteMany({ businessId: { $in: businessIds } }),
    PurchaseOrder.deleteMany({ businessId: { $in: businessIds } }),
    Supplier.deleteMany({ businessId: { $in: businessIds } }),
    AIMessage.deleteMany({ conversationId: { $in: conversations.map((c) => c._id) } }),
    AIConversation.deleteMany({ businessId: { $in: businessIds } }),
  ]);
}

const dbOk = await ensureDb();

dbSuite('DEMO-2 a tenant teardown takes everything the tenant owns', dbOk, () => {
  beforeEach(async () => {
    await ensureDb();
    await resetDemo2();
  });

  // Inside the suite, so a unit run (where dbSuite never registers the tests) does not
  // touch a database it deliberately has no connection to.
  after(async () => {
    await resetDemo2();
    await disconnectDb();
  });

  it('★ removes the target tenant’s conversations AND their messages, and counts them', async () => {
    const target = await seedTenant(targetBusiness, targetUser, 'Teardown Target');
    const keeper = await seedTenant(keeperBusiness, keeperUser, 'Teardown Keeper');

    const result = await clearTenantData([targetBusiness]);

    assert.equal(result.counts.ai_conversations, 1, 'the conversation is counted and removed');
    assert.equal(result.counts.ai_messages, 2, 'both messages are counted and removed');
    assert.equal(result.counts.products, 1, 'the previously-covered collections still work');

    assert.equal(await AIConversation.countDocuments({ businessId: targetBusiness }), 0);
    assert.equal(await AIMessage.countDocuments({ conversationId: target.conversation._id }), 0);

    // Isolation: a second tenant's history and catalogue are untouched.
    assert.equal(await AIConversation.countDocuments({ businessId: keeperBusiness }), 1);
    assert.equal(await AIMessage.countDocuments({ conversationId: keeper.conversation._id }), 2);
    assert.equal(await Product.countDocuments({ businessId: keeperBusiness }), 1);
    assert.ok(target.product && keeper.product);

    assert.equal(await countTenantLeftovers([targetBusiness]), 0, 'the verification agrees with the removal');
  });

  it('★ a tenant data reset clears its audit trail, and leaves another tenant’s alone', async () => {
    await AuditLog.create([
      { businessId: targetBusiness, action: 'PRODUCT_CREATED', entityType: 'PRODUCT' },
      { businessId: targetBusiness, action: 'STOCK_IN', entityType: 'INVENTORY' },
      { businessId: keeperBusiness, action: 'PRODUCT_CREATED', entityType: 'PRODUCT' },
    ]);

    const result = await clearTenantData([targetBusiness]);

    assert.equal(result.counts.audit_logs, 2, 'the tenant’s own governance rows go with it');
    assert.equal(await AuditLog.countDocuments({ businessId: targetBusiness }), 0);
    assert.equal(await AuditLog.countDocuments({ businessId: keeperBusiness }), 1);
    assert.equal(await countTenantLeftovers([targetBusiness]), 0);
  });

  it('★ removing a whole tenant takes its sessions and reset credentials with it', async () => {
    const target = await seedAccount(targetBusiness, targetUser, TARGET_EMAIL, TARGET_NAME);
    const keeper = await seedAccount(keeperBusiness, keeperUser, KEEPER_EMAIL, KEEPER_NAME);
    await AuditLog.create({ businessId: targetBusiness, action: 'SESSION_CREATED', entityType: 'SESSION' });

    const result = await removeTenant([targetBusiness]);

    assert.equal(result.counts.sessions, 1, 'the dead session is not left behind');
    assert.equal(result.counts.password_reset_tokens, 1);
    assert.equal(result.counts.password_reset_challenges, 1);
    assert.equal(result.counts.audit_logs, 1);
    assert.equal(result.counts.users, 1);
    assert.equal(result.counts.businesses, 1);

    assert.equal(await Session.countDocuments({ userId: target.user._id }), 0);
    assert.equal(await PasswordResetToken.countDocuments({ userId: target.user._id }), 0);
    assert.equal(await PasswordResetChallenge.countDocuments({ userId: target.user._id }), 0);
    assert.equal(await User.countDocuments({ _id: target.user._id }), 0);
    assert.equal(await Business.countDocuments({ _id: targetBusiness }), 0);

    // Isolation: the other account keeps its session and its single-use credentials.
    assert.equal(await Session.countDocuments({ userId: keeper.user._id }), 1);
    assert.equal(await PasswordResetToken.countDocuments({ userId: keeper.user._id }), 1);
    assert.equal(await PasswordResetChallenge.countDocuments({ userId: keeper.user._id }), 1);
    assert.equal(await Business.countDocuments({ _id: keeperBusiness }), 1);
  });

  it('★ the cleanup dry run counts exactly what the removal deletes, and deletes nothing', async () => {
    const target = await seedAccount(targetBusiness, targetUser, TARGET_EMAIL, TARGET_NAME);
    await seedTenant(targetBusiness, targetUser, 'Dry Run Target');
    await AuditLog.create({ businessId: targetBusiness, action: 'STOCK_IN', entityType: 'INVENTORY' });

    const preview = await countTenantRemoval([targetBusiness]);

    // Nothing moved: the tenant and its login are still there, and the count is why.
    assert.equal(await Business.countDocuments({ _id: targetBusiness }), 1);
    assert.equal(await User.countDocuments({ _id: target.user._id }), 1);
    assert.equal(await AIConversation.countDocuments({ businessId: targetBusiness }), 1);
    assert.equal(
      preview.total,
      Object.values(preview.counts).reduce((sum, count) => sum + count, 0),
      'the total is the sum of the per-collection counts',
    );

    const removal = await removeTenant([targetBusiness]);

    // The dry run is only trustworthy if it describes the REAL run byte for byte.
    assert.deepEqual(preview.counts, removal.counts);
    assert.equal(preview.total, removal.removed);
    assert.equal(await countTenantLeftovers([targetBusiness]), 0);
  });

  it('★ the data-only dry run counts exactly what clearTenantData deletes, and deletes nothing', async () => {
    const target = await seedTenant(targetBusiness, targetUser, 'Data Dry Run');

    const preview = await countTenantDataRemoval([targetBusiness]);

    // The preview must not have touched the rows it counted.
    assert.equal(await AIConversation.countDocuments({ businessId: targetBusiness }), 1);
    assert.equal(await AIMessage.countDocuments({ conversationId: target.conversation._id }), 2);
    assert.equal(await Product.countDocuments({ businessId: targetBusiness }), 1);

    const removal = await clearTenantData([targetBusiness]);
    assert.deepEqual(preview.counts, removal.counts);
    assert.equal(preview.total, removal.removed);
    assert.equal((await countTenantDataRemoval([targetBusiness])).total, 0);
  });

  it('★ the cleanup preview prints exactly the counts the delete run returns', async () => {
    await seedAccount(targetBusiness, targetUser, TARGET_EMAIL, TARGET_NAME);
    const expected = await seedEveryCleanupCollection(targetBusiness, targetUser);

    // Keep the fixture able to catch a swap: two collections sharing a count would
    // make that pair interchangeable without changing any total.
    assert.equal(
      new Set(Object.values(expected)).size,
      Object.keys(expected).length,
      'the fixture counts are no longer distinct, so a swapped pair could pass',
    );

    // What `cleanup:account --dry-run` prints. The unit suite pins the CLI to this
    // formatter and the data-only counter; this suite pins the numbers themselves.
    const preview = await countTenantDataRemoval([targetBusiness]);
    const printed = parsePreview(formatCollectionCounts(preview.counts));

    assert.deepEqual(preview.counts, expected, 'the preview counted a different fixture from the one seeded');
    assert.deepEqual(printed, expected, 'the printed breakdown lost or swapped a collection');
    assert.equal(
      preview.total,
      Object.values(expected).reduce((sum, count) => sum + count, 0),
      'the preview total is not the sum of its printed counts',
    );

    // A preview that already deleted something would make the comparison below pass
    // against a tenant it emptied before the delete run ever started.
    assert.equal(await Product.countDocuments({ businessId: targetBusiness }), expected.products);
    assert.equal(
      await AIConversation.countDocuments({ businessId: targetBusiness }),
      expected.ai_conversations,
    );

    const removal = await clearTenantData([targetBusiness]);

    // The delete returns its OWN counts, measured as rows are removed. The preview was
    // printed before that happened, from a separate read.
    assert.deepEqual(removal.counts, expected, 'the delete run removed a different fixture');
    assert.deepEqual(printed, removal.counts, 'the preview printed different counts from the delete run');
    assert.deepEqual(
      Object.keys(printed),
      Object.keys(removal.counts),
      'the preview omitted or invented a collection the delete run counted',
    );
    assert.equal(preview.total, removal.removed, 'the preview total and the removed total disagree');

    // The account rows are outside this plan: cleanup:account empties the tenant, not the login.
    assert.equal(await Business.countDocuments({ _id: targetBusiness }), 1);
    assert.equal(await User.countDocuments({ _id: targetUser }), 1);
    assert.equal((await countTenantDataRemoval([targetBusiness])).total, 0);
  });

  it('★ an empty tenant is a no-op that still reports zero, not an error', async () => {
    const result = await clearTenantData([oid()]);
    assert.equal(result.counts.ai_conversations, 0);
    assert.equal(result.counts.ai_messages, 0);
    assert.equal(result.counts.audit_logs, 0);
    assert.equal(await countTenantLeftovers([oid()]), 0);
  });

  it('★ the leftover counter sees a conversation the removal never touched', async () => {
    // Positive control: if the AI collections were absent from the counter, this
    // would report 0 and the check above would pass for the wrong reason.
    const orphan = await seedTenant(oid(), oid(), 'Counter Control');
    assert.ok(orphan.conversation);
    // 1 conversation + 2 messages + 1 product: the counter must see all four, which it
    // could not while the AI collections were absent from it.
    assert.equal(await countTenantLeftovers([orphan.conversation.businessId]), 4);
    await AIConversation.deleteMany({ businessId: orphan.conversation.businessId });
    await AIMessage.deleteMany({ conversationId: orphan.conversation._id });
    await Product.deleteMany({ businessId: orphan.conversation.businessId });
  });
});
