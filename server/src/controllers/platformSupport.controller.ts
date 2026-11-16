import type { Response } from 'express';
import mongoose from 'mongoose';

import type { PlatformRequest } from '../middlewares/platformAuthenticate.ts';
import { invalidId, throwValidation } from '../utils/errors.ts';
import ApiError from '../utils/ApiError.ts';
import { recordPlatformAudit } from '../services/platformAudit.service.ts';
import { PLATFORM_AUDIT_ACTIONS, PLATFORM_AUDIT_OUTCOMES } from '../constants/platformAudit.ts';
import {
  addSupportTicketNote,
  createSupportTicket,
  getSupportTicket,
  listSupportAssignees,
  listSupportTickets,
  updateSupportTicket,
} from '../services/platformSupport.service.ts';

function actor(req: PlatformRequest) {
  return {
    adminId: req.platformAdmin!.id,
    email: req.platformAdmin!.email,
    role: req.platformAdmin!.role,
  };
}

function ticketId(req: PlatformRequest): string {
  const id = String(req.params.id || '');
  if (!mongoose.isValidObjectId(id)) invalidId();
  return id;
}

async function auditFailure(req: PlatformRequest, action: string, err: unknown): Promise<void> {
  await recordPlatformAudit({
    action,
    outcome: PLATFORM_AUDIT_OUTCOMES.FAILURE,
    actor: actor(req),
    capability: 'platform.support.manage',
    reason: err instanceof ApiError ? String(err.code || 'support_operation_failed') : 'support_operation_failed',
    req,
  });
}

const platformSupportController = {
  async list(req: PlatformRequest, res: Response) {
    const rawLimit = req.query.limit === undefined ? 50 : Number(req.query.limit);
    if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 100) {
      throwValidation([{ field: 'limit', message: 'limit must be an integer from 1 to 100' }]);
    }
    const result = await listSupportTickets({ status: req.query.status, limit: rawLimit });
    await recordPlatformAudit({
      action: PLATFORM_AUDIT_ACTIONS.SUPPORT_TICKETS_READ,
      outcome: PLATFORM_AUDIT_OUTCOMES.SUCCESS,
      actor: actor(req),
      capability: 'platform.support.manage',
      metadata: { returned: result.tickets.length, filter: req.query.status ? String(req.query.status) : 'all' },
      req,
    });
    return res.status(200).json(result);
  },

  async get(req: PlatformRequest, res: Response) {
    const ticket = await getSupportTicket(ticketId(req));
    return res.status(200).json({ ticket });
  },

  async create(req: PlatformRequest, res: Response) {
    let ticket;
    try {
      ticket = await createSupportTicket(req.body || {}, actor(req));
    } catch (err) {
      await auditFailure(req, PLATFORM_AUDIT_ACTIONS.SUPPORT_TICKET_CREATED, err);
      throw err;
    }
    await recordPlatformAudit({
      action: PLATFORM_AUDIT_ACTIONS.SUPPORT_TICKET_CREATED,
      outcome: PLATFORM_AUDIT_OUTCOMES.SUCCESS,
      actor: actor(req),
      capability: 'platform.support.manage',
      metadata: { ticketId: ticket.id, reference: ticket.reference, priority: ticket.priority },
      req,
    });
    return res.status(201).json({ ticket });
  },

  async update(req: PlatformRequest, res: Response) {
    let ticket;
    try {
      ticket = await updateSupportTicket(ticketId(req), req.body || {}, actor(req));
    } catch (err) {
      await auditFailure(req, PLATFORM_AUDIT_ACTIONS.SUPPORT_TICKET_UPDATED, err);
      throw err;
    }
    await recordPlatformAudit({
      action: PLATFORM_AUDIT_ACTIONS.SUPPORT_TICKET_UPDATED,
      outcome: PLATFORM_AUDIT_OUTCOMES.SUCCESS,
      actor: actor(req),
      capability: 'platform.support.manage',
      metadata: { ticketId: ticket.id, reference: ticket.reference, status: ticket.status },
      req,
    });
    return res.status(200).json({ ticket });
  },

  async note(req: PlatformRequest, res: Response) {
    let ticket;
    try {
      ticket = await addSupportTicketNote(ticketId(req), req.body?.body, actor(req));
    } catch (err) {
      await auditFailure(req, PLATFORM_AUDIT_ACTIONS.SUPPORT_TICKET_NOTE_ADDED, err);
      throw err;
    }
    await recordPlatformAudit({
      action: PLATFORM_AUDIT_ACTIONS.SUPPORT_TICKET_NOTE_ADDED,
      outcome: PLATFORM_AUDIT_OUTCOMES.SUCCESS,
      actor: actor(req),
      capability: 'platform.support.manage',
      metadata: { ticketId: ticket.id, reference: ticket.reference },
      req,
    });
    return res.status(200).json({ ticket });
  },

  async assignees(_req: PlatformRequest, res: Response) {
    const assignees = await listSupportAssignees();
    return res.status(200).json({ assignees });
  },
};

export default platformSupportController;