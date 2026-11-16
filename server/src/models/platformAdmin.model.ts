import mongoose from 'mongoose';

import { PLATFORM_ROLE_VALUES, PLATFORM_ROLES } from '../constants/platformRoles.ts';

const { Schema } = mongoose;

/**
 * A Platform Operations administrator.
 *
 * THERE IS NO `businessId` AND NO TENANT ROLE, and both omissions are the design:
 * a platform administrator does not belong to a tenant, cannot be resolved from a
 * tenant `User`, and cannot be granted `OWNER`/`ADMIN` authority by any route.
 * The two identity planes share no row and no credential.
 *
 * The credential is local to this server (bcrypt) and MFA is mandatory before
 * any session is issued. TOTP secrets and WebAuthn public keys are encrypted at
 * rest by `PLATFORM_MFA_ENCRYPTION_KEY`; a missing key fails closed. This is the
 * dedicated platform identity realm: no tenant token, session or password is
 * valid here, and no platform password is valid on `/api/auth`.
 *
 * `status` is DISABLED rather than deleted so an administrator's history stays
 * attributable; a DISABLED row can never authenticate.
 */
const platformAdminSchema = new Schema(
  {
    email: {
      type: String,
      required: [true, 'email is required'],
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, 'Please provide a valid email address'],
    },
    name: {
      type: String,
      required: [true, 'name is required'],
      trim: true,
      maxlength: 120,
    },
    passwordHash: {
      type: String,
      required: [true, 'passwordHash is required'],
      // Never returned by a query unless explicitly selected.
      select: false,
    },
    role: {
      type: String,
      enum: PLATFORM_ROLE_VALUES,
      default: PLATFORM_ROLES.READ_ONLY,
    },
    status: {
      type: String,
      enum: ['ACTIVE', 'DISABLED'],
      default: 'ACTIVE',
    },
    // Set when the credential changes; a token minted before it is refused on
    // the next request, exactly as the tenant plane does with its own stamp.
    passwordChangedAt: {
      type: Date,
      default: null,
    },
    lastLoginAt: {
      type: Date,
      default: null,
    },
    // Mandatory MFA state. `mfaEnabled` is only true after a TOTP code has been
    // confirmed; the encrypted secret is never selected by ordinary reads and
    // is never returned by any DTO.
    mfaEnabled: {
      type: Boolean,
      default: false,
    },
    totpSecretEncrypted: {
      type: String,
      default: null,
      select: false,
    },
    totpEnrolledAt: {
      type: Date,
      default: null,
    },
    // Highest accepted RFC 6238 time-step. A second submission of the same code
    // is rejected, so a code observed in transit cannot be replayed.
    lastTotpCounter: {
      type: Number,
      default: 0,
    },
    // Recovery codes are generated only after a re-authentication with the
    // current password. The plaintext code is shown once by the generating
    // response; this collection stores only a SHA-256 digest and the time the
    // code was spent. A code is single-use and cannot be selected by an
    // ordinary administrator read.
    recoveryCodes: {
      type: [
        new Schema(
          {
            codeHash: { type: String, required: true },
            usedAt: { type: Date, default: null },
          },
          { _id: false },
        ),
      ],
      default: [],
      select: false,
    },
    recoveryCodesGeneratedAt: {
      type: Date,
      default: null,
    },
    // Account-scoped failed-MFA budget. An IP limiter cannot stop an attacker
    // who rotates addresses, so these fields are the durable backstop shared by
    // TOTP, WebAuthn and recovery-code verification. A lock is temporary; a
    // successful factor clears the budget immediately.
    mfaFailedAttempts: {
      type: Number,
      default: 0,
    },
    mfaFailedWindowStartedAt: {
      type: Date,
      default: null,
    },
    mfaLockedUntil: {
      type: Date,
      default: null,
    },
    webauthnCredentials: {
      type: [
        new Schema(
          {
            credentialId: { type: String, required: true, trim: true },
            publicKeyEncrypted: { type: String, required: true },
            counter: { type: Number, default: 0 },
            transports: { type: [String], default: [] },
            label: { type: String, default: 'Security key', trim: true, maxlength: 80 },
            createdAt: { type: Date, default: Date.now },
            lastUsedAt: { type: Date, default: null },
          },
          { _id: false },
        ),
      ],
      default: [],
      select: false,
    },
    // One-time login challenges. The options response is stateless, so the
    // server stores only a hash here and atomically removes it while accepting
    // the assertion. A captured assertion therefore cannot open a second
    // session, including on an authenticator whose counter stays 0.
    webauthnChallenges: {
      type: [
        new Schema(
          {
            challengeHash: { type: String, required: true },
            expiresAt: { type: Date, required: true },
          },
          { _id: false },
        ),
      ],
      default: [],
      select: false,
    },
  },
  { collection: 'platform_admins', timestamps: true },
);

platformAdminSchema.index({ role: 1, status: 1 });
platformAdminSchema.index({ 'webauthnCredentials.credentialId': 1 });

const PlatformAdmin = mongoose.model('PlatformAdmin', platformAdminSchema);

export default PlatformAdmin;
