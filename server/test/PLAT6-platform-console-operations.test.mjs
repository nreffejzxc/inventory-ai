// PLAT-6 — support workflow, health-only status, deployment history and the
// same-origin console host. These tests use the real Express app and a real
// database; they do not mock authorization.

process.env.PLATFORM_ADMIN_JWT_SECRET =
  'test-platform-admin-secret-0123456789abcdef0123456789abcdef';
process.env.PLATFORM_MFA_ENCRYPTION_KEY =
  'test-platform-mfa-key-0123456789abcdef0123456789abcdef';

import { after, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import mongoose from 'mongoose';

import { dbSuite } from './testEnv.mjs';
import {
  createTracker,
  disconnectDb,
  makeApi,
  startServer,
  uniqueEmail,
} from './support.mjs';
import { createPlatformAdminAccount } from '../src/services/platformAuth.service.ts';
import { signPlatformAccessToken } from '../src/config/platformJwt.ts';
import { createPlatformSessionForToken } from '../src/services/platformSession.service.ts';
import PlatformAuditLog from '../src/models/platformAuditLog.model.ts';

const PASSWORD = 'PlatformPass123!x';
const { dbOk, baseUrl, server } = await startServer();
const api = makeApi(baseUrl);
const tracker = createTracker(dbOk);
const createdAdminIds = [];

async function platformToken(role) {
  const admin = await createPlatformAdminAccount({
    email: uniqueEmail(`plat6-${role.toLowerCase()}`),
    name: `PLAT-6 ${role}`,
    password: PASSWORD,
    role,
  });
  createdAdminIds.push(String(admin._id));
  const token = signPlatformAccessToken(admin._id, crypto.randomUUID());
  await createPlatformSessionForToken({
    adminId: admin._id,
    token,
    deviceLabel: 'PLAT-6 test',
  });
  return { admin, token };
}

dbSuite('PLAT-6 support and operator modules', dbOk, () => {
  let support;
  let readOnly;
  let ticket;

  it('creates support and read-only operators through the platform realm', async () => {
    support = await platformToken('SUPPORT');
    readOnly = await platformToken('READ_ONLY');
    assert.equal(support.admin.role, 'SUPPORT');
    assert.equal(readOnly.admin.role, 'READ_ONLY');
  });

  it('gives READ_ONLY health only, not the cross-tenant report or tickets', async () => {
    const status = await api('GET', '/api/platform/status', { token: readOnly.token });
    assert.equal(status.status, 200, JSON.stringify(status.json));
    assert.equal(status.json.metricsAvailable, false);
    assert.equal(status.json.service.status, 'ok');
    assert.ok(Array.isArray(status.json.infrastructure.checks));

    const operations = await api('GET', '/api/platform/operations', { token: readOnly.token });
    assert.equal(operations.status, 403);
    assert.equal(operations.json.code, 'PLATFORM_FORBIDDEN');

    const tickets = await api('GET', '/api/platform/tickets', { token: readOnly.token });
    assert.equal(tickets.status, 403);
    assert.equal(tickets.json.code, 'PLATFORM_FORBIDDEN');
  });

  it('creates, lists, transitions and notes a tenant-free support ticket', async () => {
    const created = await api('POST', '/api/platform/tickets', {
      token: support.token,
      body: {
        title: 'Checkout reconciliation concern',
        description: 'A stock movement was reported as missing after a retry.',
        category: 'DATA_SYNC',
        priority: 'HIGH',
        severity: 'HIGH',
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    ticket = created.json.ticket;
    assert.equal(ticket.status, 'NEW');
    assert.equal(ticket.createdByEmail, support.admin.email);
    assert.equal('businessId' in ticket, false);
    assert.equal(JSON.stringify(ticket).includes('businessId'), false);

    const listed = await api('GET', '/api/platform/tickets?limit=20', { token: support.token });
    assert.equal(listed.status, 200, JSON.stringify(listed.json));
    assert.ok(listed.json.tickets.some((row) => row.id === ticket.id));
    assert.ok(listed.json.summary.total >= 1);

    const badTransition = await api('PATCH', `/api/platform/tickets/${ticket.id}`, {
      token: support.token,
      body: { status: 'RESOLVED' },
    });
    assert.equal(badTransition.status, 400);
    assert.equal(badTransition.json.code, 'VALIDATION_ERROR');

    const updated = await api('PATCH', `/api/platform/tickets/${ticket.id}`, {
      token: support.token,
      body: { status: 'UNDER_INVESTIGATION', priority: 'URGENT' },
    });
    assert.equal(updated.status, 200, JSON.stringify(updated.json));
    assert.equal(updated.json.ticket.status, 'UNDER_INVESTIGATION');
    assert.equal(updated.json.ticket.priority, 'URGENT');

    const noted = await api('POST', `/api/platform/tickets/${ticket.id}/notes`, {
      token: support.token,
      body: { body: 'Reproduced against the ledger; investigating the retry path.' },
    });
    assert.equal(noted.status, 200, JSON.stringify(noted.json));
    assert.equal(noted.json.ticket.notes.length, 1);
    assert.equal(noted.json.ticket.notes[0].authorEmail, support.admin.email);

    const detail = await api('GET', `/api/platform/tickets/${ticket.id}`, {
      token: support.token,
    });
    assert.equal(detail.status, 200);
    assert.equal(detail.json.ticket.reference, ticket.reference);
    assert.equal(detail.json.ticket.transitions.length, 2);
  });

  it('reports only aggregate support facts in the operations response', async () => {
    const report = await api('GET', '/api/platform/operations?days=7', { token: support.token });
    assert.equal(report.status, 200, JSON.stringify(report.json));
    assert.ok(report.json.support.total >= 1);
    assert.ok(report.json.inventory && typeof report.json.inventory.records === 'number');
    assert.equal(JSON.stringify(report.json).includes('Checkout reconciliation concern'), false);
    assert.equal(JSON.stringify(report.json).includes(support.admin.email), false);
  });

  it('returns observed deployment history without secrets', async () => {
    const response = await api('GET', '/api/platform/deployments?limit=10', {
      token: support.token,
    });
    assert.equal(response.status, 200, JSON.stringify(response.json));
    assert.equal(typeof response.json.current.commit, 'string');
    assert.ok(Array.isArray(response.json.deployments));
    const body = JSON.stringify(response.json);
    assert.equal(body.includes('MONGODB_URI'), false);
    assert.equal(body.includes('PLATFORM_ADMIN_JWT_SECRET'), false);
  });

  it('writes support audit events for every successful mutation', async () => {
    const events = await PlatformAuditLog.find({
      actorAdminId: new mongoose.Types.ObjectId(support.admin._id),
      action: {
        $in: [
          'platform.support.ticket_created',
          'platform.support.ticket_updated',
          'platform.support.ticket_note_added',
        ],
      },
    }).lean();
    assert.equal(events.length, 4, JSON.stringify(events.map((event) => event.action)));
    assert.equal(events.filter((event) => event.outcome === 'SUCCESS').length, 3);
    assert.equal(events.filter((event) => event.outcome === 'FAILURE').length, 1);
  });
});

after(async () => {
  if (dbOk) {
    const db = mongoose.connection.db;
    if (createdAdminIds.length) {
      const ids = createdAdminIds.map((id) => new mongoose.Types.ObjectId(id));
      await db.collection('platform_audit_events').deleteMany({ actorAdminId: { $in: ids } });
      await db.collection('platform_admin_sessions').deleteMany({ adminId: { $in: ids } });
      await db.collection('platform_support_tickets').deleteMany({ createdByAdminId: { $in: ids } });
      await db.collection('platform_admins').deleteMany({ _id: { $in: ids } });
    }
  }
  await tracker.cleanup();
  if (server) await new Promise((resolve) => server.close(resolve));
  await disconnectDb();
});