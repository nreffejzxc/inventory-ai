import crypto from 'node:crypto';

import mongoose from 'mongoose';

import PlatformAdmin from '../models/platformAdmin.model.ts';
import PlatformTicket, {
  TICKET_CATEGORIES,
  TICKET_PRIORITIES,
  TICKET_SEVERITIES,
  TICKET_STATUSES,
} from '../models/platformTicket.model.ts';
import ApiError from '../utils/ApiError.ts';
import { throwValidation } from '../utils/errors.ts';

const CATEGORY_VALUES = TICKET_CATEGORIES;
const PRIORITY_VALUES = TICKET_PRIORITIES;
const SEVERITY_VALUES = TICKET_SEVERITIES;
const STATUS_VALUES = TICKET_STATUSES;

const ALLOWED_TRANSITIONS: Record<string, readonly string[]> = {
  NEW: ['UNDER_INVESTIGATION', 'CLOSED'],
  UNDER_INVESTIGATION: ['ESCALATED', 'FIX_IN_PROGRESS', 'RESOLVED', 'CLOSED'],
  ESCALATED: ['FIX_IN_PROGRESS', 'RESOLVED', 'CLOSED'],
  FIX_IN_PROGRESS: ['RESOLVED', 'CLOSED'],
  RESOLVED: ['CLOSED', 'UNDER_INVESTIGATION'],
  CLOSED: [],
};

export type SupportActor = { adminId: string; email: string; role: string };

function clean(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function validation(field: string, message: string): never {
  throwValidation([{ field, message }]);
  throw new Error('validation always throws');
}

function ticketReference(): string {
  return `TKT-${new Date().toISOString().slice(2, 10).replace(/-/g, '')}-${crypto
    .randomBytes(3)
    .toString('hex')
    .toUpperCase()}`;
}

function objectId(value: unknown, field: string): string {
  const id = clean(value, 64);
  if (!mongoose.isValidObjectId(id)) validation(field, `${field} must be a valid id`);
  return id;
}

function enumValue<T extends string>(
  value: unknown,
  values: readonly T[],
  field: string,
  fallback?: T,
): T {
  const candidate = clean(value, 40).toUpperCase();
  if (!candidate && fallback !== undefined) return fallback;
  if (!values.includes(candidate as T)) {
    validation(field, `${field} must be one of: ${[...values].join(', ')}`);
  }
  return candidate as T;
}

function assertActor(actor: SupportActor): void {
  if (!mongoose.isValidObjectId(actor.adminId)) {
    throw new ApiError(401, 'Platform authentication required', 'PLATFORM_AUTH_REQUIRED');
  }
}

async function assignee(adminId: unknown): Promise<{ id: string; email: string } | null> {
  if (adminId === null || adminId === undefined || adminId === '') return null;
  const id = objectId(adminId, 'assignedAdminId');
  const admin = await PlatformAdmin.findOne({ _id: id, status: 'ACTIVE' })
    .select('email')
    .lean();
  if (!admin) validation('assignedAdminId', 'assignedAdminId must name an active platform administrator');
  return { id, email: String(admin.email) };
}

export type TicketDto = {
  id: string;
  reference: string;
  title: string;
  description: string;
  category: string;
  priority: string;
  severity: string;
  status: string;
  assignedAdminId: string | null;
  assignedEmail: string | null;
  createdByEmail: string;
  notes: Array<{ body: string; authorEmail: string; createdAt: string }>;
  transitions: Array<{ from: string | null; to: string; actorEmail: string; at: string }>;
  resolvedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

function iso(value: unknown): string | null {
  return value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : null;
}

function toDto(row: Record<string, unknown>): TicketDto {
  return {
    id: String(row._id),
    reference: String(row.reference),
    title: String(row.title),
    description: String(row.description),
    category: String(row.category),
    priority: String(row.priority),
    severity: String(row.severity),
    status: String(row.status),
    assignedAdminId: row.assignedAdminId ? String(row.assignedAdminId) : null,
    assignedEmail: typeof row.assignedEmail === 'string' ? row.assignedEmail : null,
    createdByEmail: String(row.createdByEmail),
    notes: Array.isArray(row.notes)
      ? row.notes.map((note: Record<string, unknown>) => ({
          body: String(note.body),
          authorEmail: String(note.authorEmail),
          createdAt: iso(note.createdAt) || '',
        }))
      : [],
    transitions: Array.isArray(row.transitions)
      ? row.transitions.map((transition: Record<string, unknown>) => ({
          from: transition.from ? String(transition.from) : null,
          to: String(transition.to),
          actorEmail: String(transition.actorEmail),
          at: iso(transition.at) || '',
        }))
      : [],
    resolvedAt: iso(row.resolvedAt),
    closedAt: iso(row.closedAt),
    createdAt: iso(row.createdAt) || '',
    updatedAt: iso(row.updatedAt) || '',
  };
}

export async function createSupportTicket(
  input: Record<string, unknown>,
  actor: SupportActor,
): Promise<TicketDto> {
  assertActor(actor);
  const title = clean(input.title, 160);
  const description = clean(input.description, 4000);
  if (title.length < 3) validation('title', 'title must be at least 3 characters');
  if (description.length < 3) validation('description', 'description must be at least 3 characters');
  const category = enumValue(input.category, CATEGORY_VALUES, 'category');
  const priority = enumValue(input.priority, PRIORITY_VALUES, 'priority', 'MEDIUM');
  const severity = enumValue(input.severity, SEVERITY_VALUES, 'severity', 'MEDIUM');
  const assigned = await assignee(input.assignedAdminId);

  let row: Record<string, unknown> | null = null;
  for (let attempt = 0; attempt < 3 && !row; attempt += 1) {
    try {
      const created = await PlatformTicket.create({
        reference: ticketReference(),
        title,
        description,
        category,
        priority,
        severity,
        status: 'NEW',
        assignedAdminId: assigned?.id ?? null,
        assignedEmail: assigned?.email ?? null,
        createdByAdminId: actor.adminId,
        createdByEmail: actor.email,
        transitions: [{ from: null, to: 'NEW', actorAdminId: actor.adminId, actorEmail: actor.email }],
      });
      row = created.toObject() as unknown as Record<string, unknown>;
    } catch (err) {
      if ((err as { code?: number }).code !== 11000 || attempt === 2) throw err;
    }
  }
  if (!row) throw new ApiError(500, 'Could not create the support ticket', 'TICKET_CREATE_FAILED');
  return toDto(row);
}

export async function listSupportTickets({
  status,
  limit = 50,
}: {
  status?: unknown;
  limit?: number;
}): Promise<{
  tickets: Omit<TicketDto, 'notes' | 'transitions'>[];
  summary: Record<string, number>;
  hasMore: boolean;
}> {
  const bounded = Math.min(100, Math.max(1, Math.trunc(limit)));
  const filter: Record<string, unknown> = {};
  const normalized = clean(status, 40).toUpperCase();
  if (normalized) {
    if (!(STATUS_VALUES as readonly string[]).includes(normalized)) {
      validation('status', 'status is not a recognised ticket status');
    }
    filter.status = normalized;
  }
  const [rows, summaryRows] = await Promise.all([
    PlatformTicket.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(bounded + 1)
      .lean(),
    PlatformTicket.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
  ]);
  const summary: { total: number } & Record<string, number> = { total: 0 };
  for (const row of summaryRows) {
    if (typeof row._id === 'string') {
      summary[row._id] = Number(row.count) || 0;
      summary.total += Number(row.count) || 0;
    }
  }
  return {
    tickets: rows.slice(0, bounded).map((row) => {
      const dto = toDto(row);
      return {
        id: dto.id,
        reference: dto.reference,
        title: dto.title,
        description: dto.description.slice(0, 240),
        category: dto.category,
        priority: dto.priority,
        severity: dto.severity,
        status: dto.status,
        assignedAdminId: dto.assignedAdminId,
        assignedEmail: dto.assignedEmail,
        createdByEmail: dto.createdByEmail,
        resolvedAt: dto.resolvedAt,
        closedAt: dto.closedAt,
        createdAt: dto.createdAt,
        updatedAt: dto.updatedAt,
      };
    }),
    summary,
    hasMore: rows.length > bounded,
  };
}

export async function getSupportTicket(id: string): Promise<TicketDto> {
  const row = await PlatformTicket.findById(objectId(id, 'id')).lean();
  if (!row) throw new ApiError(404, 'Support ticket not found', 'TICKET_NOT_FOUND');
  return toDto(row);
}

export async function updateSupportTicket(
  id: string,
  patch: Record<string, unknown>,
  actor: SupportActor,
): Promise<TicketDto> {
  assertActor(actor);
  const row = await PlatformTicket.findById(objectId(id, 'id'));
  if (!row) throw new ApiError(404, 'Support ticket not found', 'TICKET_NOT_FOUND');

  const updates: Record<string, unknown> = {};
  if (patch.priority !== undefined) updates.priority = enumValue(patch.priority, PRIORITY_VALUES, 'priority');
  if (patch.severity !== undefined) updates.severity = enumValue(patch.severity, SEVERITY_VALUES, 'severity');
  if (patch.category !== undefined) updates.category = enumValue(patch.category, CATEGORY_VALUES, 'category');
  if (patch.assignedAdminId !== undefined) {
    const assigned = await assignee(patch.assignedAdminId);
    updates.assignedAdminId = assigned?.id ?? null;
    updates.assignedEmail = assigned?.email ?? null;
  }
  if (patch.status !== undefined) {
    const next = enumValue(patch.status, STATUS_VALUES, 'status');
    if (next !== row.status) {
      if (!ALLOWED_TRANSITIONS[row.status]?.includes(next)) {
        validation('status', `status cannot move from ${row.status} to ${next}`);
      }
      updates.status = next;
      if (next === 'RESOLVED' && !row.resolvedAt) updates.resolvedAt = new Date();
      if (next === 'CLOSED') {
        updates.closedAt = new Date();
        if (!row.resolvedAt) updates.resolvedAt = new Date();
      }
      row.transitions.push({
        from: row.status,
        to: next,
        actorAdminId: new mongoose.Types.ObjectId(actor.adminId),
        actorEmail: actor.email,
        at: new Date(),
      } as never);
    }
  }
  if (Object.keys(updates).length === 0) validation('patch', 'at least one supported field is required');

  Object.assign(row, updates);
  await row.save();
  return toDto(row.toObject());
}

export async function addSupportTicketNote(
  id: string,
  body: unknown,
  actor: SupportActor,
): Promise<TicketDto> {
  assertActor(actor);
  const note = clean(body, 4000);
  if (!note) validation('body', 'note body is required');
  const row = await PlatformTicket.findById(objectId(id, 'id'));
  if (!row) throw new ApiError(404, 'Support ticket not found', 'TICKET_NOT_FOUND');
  row.notes.push({
    body: note,
    authorAdminId: new mongoose.Types.ObjectId(actor.adminId),
    authorEmail: actor.email,
    createdAt: new Date(),
  } as never);
  await row.save();
  return toDto(row.toObject());
}

export async function listSupportAssignees(): Promise<
  Array<{ id: string; name: string; email: string; role: string }>
> {
  const rows = await PlatformAdmin.find({ status: 'ACTIVE' })
    .select('name email role')
    .sort({ name: 1, email: 1 })
    .lean();
  return rows.map((row) => ({
    id: String(row._id),
    name: String(row.name),
    email: String(row.email),
    role: String(row.role),
  }));
}

export default {
  createSupportTicket,
  listSupportTickets,
  getSupportTicket,
  updateSupportTicket,
  addSupportTicketNote,
  listSupportAssignees,
};