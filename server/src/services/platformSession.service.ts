import crypto from 'node:crypto';

import mongoose from 'mongoose';

import PlatformAdminSession from '../models/platformAdminSession.model.ts';
import ApiError from '../utils/ApiError.ts';
import { decodePlatformAccessToken } from '../config/platformJwt.ts';

/**
 * PLAT-1 — platform session lifecycle.
 *
 * A platform session is the server-side half of a platform token: the token's
 * `jti` names a row here, and `requirePlatformAdmin` refuses a token whose row is
 * missing, revoked, idle-expired or past its absolute cap.
 *
 * SEPARATE COLLECTION, SEPARATE OWNER. `sessions` belongs to tenant `User` rows;
 * this module never queries it, and `services/session.service.ts` never queries
 * this collection. No function here accepts an admin id from a request body — the
 * id comes from the verified token and the loaded `PlatformAdmin` row.
 */

export const PLATFORM_SESSION_ABSOLUTE_CAP_MS = 8 * 60 * 60 * 1000;
export const PLATFORM_SESSION_IDLE_MS = 15 * 60 * 1000;

export const PLATFORM_SESSION_REVOKED_CODE = 'PLATFORM_SESSION_REVOKED';
export const PLATFORM_SESSION_REVOKED_MESSAGE = 'Platform session ended — please sign in again';
export const PLATFORM_SESSION_EXPIRED_CODE = 'PLATFORM_SESSION_EXPIRED';
export const PLATFORM_SESSION_EXPIRED_MESSAGE = 'Platform session expired — please sign in again';

const DEVICE_LABEL_MAX = 60;
const DEFAULT_DEVICE_LABEL = 'Unknown device';

type SessionDoc = mongoose.HydratedDocFromModel<typeof PlatformAdminSession>;

export function newPlatformSessionId(): string {
  return crypto.randomUUID();
}

export function normalizePlatformDeviceLabel(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_DEVICE_LABEL;
  const trimmed = value.trim();
  if (!trimmed) return DEFAULT_DEVICE_LABEL;
  return trimmed.slice(0, DEVICE_LABEL_MAX);
}

type CreatePlatformSessionInput = {
  adminId: string | mongoose.Types.ObjectId;
  token: string;
  deviceLabel?: unknown;
  now?: Date;
};

/**
 * Persist the session for a token that was just signed.
 *
 * `expiresAt` is the ABSOLUTE 8-hour cap, anchored here and never extended by a
 * renewal. `lastUsedAt` starts at creation rather than null so the idle test has
 * a real timestamp from the first moment.
 */
export async function createPlatformSessionForToken({
  adminId,
  token,
  deviceLabel,
  now = new Date(),
}: CreatePlatformSessionInput) {
  const payload = decodePlatformAccessToken(token);
  if (!payload?.jti) {
    throw new ApiError(
      500,
      'The platform token carries no session id',
      'PLATFORM_SESSION_ID_REQUIRED',
    );
  }
  return PlatformAdminSession.create({
    adminId,
    jti: payload.jti,
    deviceLabel: normalizePlatformDeviceLabel(deviceLabel),
    lastUsedAt: now,
    expiresAt: new Date(now.getTime() + PLATFORM_SESSION_ABSOLUTE_CAP_MS),
  });
}

/**
 * The row a token names, WITHOUT deciding whether it is still usable. Kept
 * separate so the caller can answer a revoked session and an expired session
 * with different codes — the distinction is what tells an operator to sign in
 * again rather than that their session was withdrawn.
 */
export async function findPlatformSessionByJti(jti: unknown) {
  if (typeof jti !== 'string' || jti.length === 0) return null;
  return PlatformAdminSession.findOne({ jti });
}

export type PlatformSessionState = 'active' | 'revoked' | 'expired';

/** Classify a session row at one instant. Pure, so the boundaries are testable. */
export function platformSessionState(
  session: Pick<SessionDoc, 'revokedAt' | 'expiresAt' | 'lastUsedAt'>,
  now: Date = new Date(),
): PlatformSessionState {
  if (session.revokedAt) return 'revoked';
  if (session.expiresAt.getTime() <= now.getTime()) return 'expired';
  if (now.getTime() - session.lastUsedAt.getTime() >= PLATFORM_SESSION_IDLE_MS) return 'expired';
  return 'active';
}

/** Record that the session was used. One cheap write per authenticated request. */
export async function touchPlatformSession(session: SessionDoc, now: Date = new Date()) {
  try {
    await PlatformAdminSession.updateOne(
      { _id: session._id, revokedAt: null },
      { $set: { lastUsedAt: now } },
    );
  } catch (err) {
    console.error(
      `[platform-session] lastUsedAt update failed for ${String(session._id)}: ${
        (err as { message?: unknown }).message
      }`,
    );
  }
}

/** End the session the current platform request authenticated with. */
export async function revokePlatformSessionByJti({
  adminId,
  jti,
  now = new Date(),
}: {
  adminId: string | mongoose.Types.ObjectId;
  jti: string;
  now?: Date;
}) {
  return PlatformAdminSession.findOneAndUpdate(
    { adminId, jti, revokedAt: null },
    { $set: { revokedAt: now } },
    { returnDocument: 'after' },
  );
}

export default {
  PLATFORM_SESSION_ABSOLUTE_CAP_MS,
  PLATFORM_SESSION_IDLE_MS,
  PLATFORM_SESSION_REVOKED_CODE,
  PLATFORM_SESSION_REVOKED_MESSAGE,
  PLATFORM_SESSION_EXPIRED_CODE,
  PLATFORM_SESSION_EXPIRED_MESSAGE,
  newPlatformSessionId,
  normalizePlatformDeviceLabel,
  createPlatformSessionForToken,
  findPlatformSessionByJti,
  platformSessionState,
  touchPlatformSession,
  revokePlatformSessionByJti,
};
