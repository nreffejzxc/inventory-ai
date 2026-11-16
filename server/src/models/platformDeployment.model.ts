import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * PLAT-6 — one observed process boot.
 *
 * This is an observation, not a deployment authority: it records the commit the
 * running process reports and when that process started. It cannot know whether
 * Render's build failed before the process started. History therefore begins at
 * the first console-enabled boot; it is never back-filled with guesses.
 */
const platformDeploymentSchema = new Schema(
  {
    commit: { type: String, required: true, trim: true, maxlength: 40 },
    environment: { type: String, required: true, trim: true, maxlength: 30 },
    nodeVersion: { type: String, required: true, trim: true, maxlength: 30 },
    startedAt: { type: Date, required: true },
    recordedAt: { type: Date, required: true, default: Date.now },
    expiresAt: { type: Date, required: true },
  },
  { collection: 'platform_deployments', timestamps: false },
);

platformDeploymentSchema.index({ startedAt: -1, _id: -1 });
platformDeploymentSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
platformDeploymentSchema.index({ commit: 1, startedAt: 1 }, { unique: true });

const PlatformDeployment = mongoose.model('PlatformDeployment', platformDeploymentSchema);

export default PlatformDeployment;