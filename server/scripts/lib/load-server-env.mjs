// Load `server/.env` regardless of the working directory the caller used.
//
// WHY THIS EXISTS. `import 'dotenv/config'` resolves `.env` from process.cwd().
// The scheduled integrity wrapper sets its working directory to the REPOSITORY
// ROOT, so the heartbeat writer found no `.env`, reported `MONGODB_URI is not
// set`, and left `/api/health/integrity` at 503 while the audit itself succeeded.
// Resolving the file from this module's own location makes the writer work from
// the repo root, from `server/`, or from anywhere else.
//
// Import this module BEFORE any module that reads `config/env.ts`.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
// `quiet` keeps dotenv's informational banner off stderr. The scheduled wrapper
// captures stderr and (in Windows PowerShell 5) a native stderr line under
// `$ErrorActionPreference = 'Stop'` becomes a terminating error — which is how a
// successful load was reported as a failed heartbeat run.
dotenv.config({ path: path.resolve(scriptDir, '..', '..', '.env'), quiet: true });
