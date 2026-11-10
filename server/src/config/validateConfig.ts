/**
 * Production configuration validation (Phase 07D / H7).
 *
 * The server only accepts traffic in production when the environment is
 * genuinely runnable, so a broken deploy fails fast at startup (non-zero exit)
 * instead of booting and answering every request with a 500.
 *
 * Checks:
 *   - MONGODB_URI   present (never logged; "usable" is verified by the startup
 *                   database connection — see config/startup.ts).
 *   - JWT_SECRET    present and long enough to be a credible signing secret.
 *   - JWT_EXPIRES_IN, when set, is a timespan jsonwebtoken can parse (probed
 *                   with a throwaway signature so a malformed value fails at
 *                   boot instead of turning the first login into a 500).
 *   - AI_PROVIDER   when a provider IS configured, the keys that provider needs
 *                   are present (respecting the provider abstraction: the
 *                   provider layer declares its own requirements). An empty
 *                   AI_PROVIDER is the supported "AI disabled" state.
 *   - Firebase      when a service account IS configured, it must be complete and
 *                   usable. An entirely unset Firebase configuration is the
 *                   supported "Firebase disabled" state and is NOT a problem —
 *                   which is what keeps an existing deployment bootable when
 *                   Firebase is added but not yet used (Phase 32B adds no route).
 *   - Email-verification pepper (AUTH-04-A): when Firebase IS configured, the
 *                   EMAIL_VERIFICATION_CODE_PEPPER the 6-digit code flow keys its
 *                   digests with must be present and long enough. An unconfigured
 *                   Firebase is again the supported "flow not enabled" state and
 *                   is NOT a problem, so this adds no failure to a deployment
 *                   that never turns the flow on.
 *
 * Problems are returned as { variable, message } objects. Messages name the
 * VARIABLE that is wrong — they never contain the variable's value, so no
 * secret (connection string, JWT, API key) can ever be printed.
 */

import jwt from 'jsonwebtoken';
import type { SignOptions } from 'jsonwebtoken';

import { providerRequiredEnv } from '../services/ai/providers/index.ts';
import { reasoningConfigProblems } from '../services/ai/reasoningPolicy.ts';
import { webCapabilities } from '../services/ai/webCapabilities.ts';
import { serviceAccountProblems } from './firebase.ts';
import { emailVerificationPepperProblems } from './emailVerification.ts';

/**
 * One problem with the production configuration. `message` names the VARIABLE
 * that is wrong and never carries its value, so no secret can be printed.
 */
export type ConfigProblem = { variable: string; message: string };

/** Minimum JWT_SECRET length. A short secret is not a credible HS256 signing key. */
export const JWT_SECRET_MIN_LENGTH = 32;

function missing(variable: string): ConfigProblem {
  return { variable, message: `Missing required environment variable: ${variable}` };
}

/**
 * Validate the production configuration against `values` (defaults to
 * process.env). Returns an array of { variable, message } problems — empty when
 * the configuration is valid. Never includes secret values.
 */
export function validateProductionConfig(
  values: Record<string, string | undefined> = process.env
): ConfigProblem[] {
  const problems: ConfigProblem[] = [];
  const get = (key: string) => {
    // Optional chaining reproduces the original `values && ...` guard; a missing
    // or non-string entry still yields '' rather than undefined.
    const raw = values?.[key];
    return typeof raw === 'string' ? raw.trim() : '';
  };

  if (!get('MONGODB_URI')) {
    problems.push(missing('MONGODB_URI'));
  }

  const jwtSecret = get('JWT_SECRET');
  if (!jwtSecret) {
    problems.push(missing('JWT_SECRET'));
  } else if (jwtSecret.length < JWT_SECRET_MIN_LENGTH) {
    problems.push({
      variable: 'JWT_SECRET',
      message: `JWT_SECRET must be at least ${JWT_SECRET_MIN_LENGTH} characters in production`,
    });
  }

  // Phase 07G: env.ts passes JWT_EXPIRES_IN straight to jsonwebtoken, so a
  // malformed value today only fails on the FIRST login — as a 500 — instead of
  // at boot. Probe it with a throwaway signature (never transmitted, nothing
  // persisted) reusing jsonwebtoken's own parser, so this check can never
  // disagree with signAccessToken about what is valid. An empty value is left
  // alone: env.ts already treats it as absent and applies the "1h" default.
  //
  // AUTH-02: the default is now 1 hour. JWT_ISSUER / JWT_AUDIENCE need no probe
  // of their own — they are non-secret strings that env.ts defaults, and
  // jsonwebtoken accepts any string for both.
  const jwtExpiresIn = get('JWT_EXPIRES_IN');
  if (jwtSecret && jwtExpiresIn) {
    try {
      jwt.sign({ sub: 'startup-config-probe' }, jwtSecret, {
        algorithm: 'HS256',
        // Same operator-supplied timespan as config/jwt.ts. Probing with the
        // value jsonwebtoken itself would parse is the point of this check, so
        // the cast states a contract the next line already enforces.
        expiresIn: jwtExpiresIn as SignOptions['expiresIn'],
      });
    } catch {
      problems.push({
        variable: 'JWT_EXPIRES_IN',
        message:
          'JWT_EXPIRES_IN is not a valid expiration string. Use a jsonwebtoken timespan such as "1h", "15m", or "2h", or a number of seconds.',
      });
    }
  }

  const provider = get('AI_PROVIDER');
  if (provider) {
    const required = providerRequiredEnv(provider);
    if (required === null) {
      problems.push({
        variable: 'AI_PROVIDER',
        message:
          'AI_PROVIDER is set to an unsupported provider. Use "openrouter", or leave it empty to disable the AI assistant. (The direct "claude" and "gemini" providers were removed in AI-25; both are reachable through OpenRouter as model choices.)',
      });
    } else {
      for (const variable of required) {
        if (!get(variable)) {
          problems.push({
            variable,
            message: `Missing required environment variable: ${variable} (required by the configured AI provider "${provider}")`,
          });
        }
      }
      // AI-85 — the two optional web-tool switches are independent. An invalid
      // value is a production configuration error rather than a silent no-op;
      // the tools remain disabled until the operator fixes the value.
      problems.push(...webCapabilities(values).problems);
      // AI-100 — the reasoning switches are strict enable/disable settings. An
      // invalid value must fail the deploy instead of silently choosing a policy
      // for a paid model or a free fallback.
      problems.push(...reasoningConfigProblems(values));
    }
  }

  // Phase 32B: Firebase Admin credentials.
  //
  // ALL-OR-NOTHING, and the empty case is deliberately not a problem. Firebase is
  // an identity provider this server can run without — Phase 32B adds no route
  // that uses it — so requiring these variables in production would make every
  // existing deployment fail to boot the moment the code shipped. A partially
  // supplied service account IS a problem, because a half-configured credential
  // fails later, at the first token exchange, where the error is far harder to
  // trace back to a missing variable.
  //
  // The check itself lives in config/firebase.ts, shared with the runtime
  // resolver, so validation and use can never disagree about what "configured"
  // means. It reports variable NAMES only and never a value — including on a JSON
  // parse failure, where a parser's own message could quote the credential it
  // rejected.
  problems.push(...serviceAccountProblems(values));

  // AUTH-04-A: the email-verification code pepper.
  //
  // GATED ON FIREBASE, AND THE GATING IS THE CONTRACT. The AUTH-04 flow verifies a
  // Firebase ID token before it does anything, so a pepper is meaningless without
  // a service account — and, more importantly, a check that fired regardless
  // would add a config failure to every deployment that never enables the flow,
  // which is exactly the additive property Phase 32B established. The predicate
  // and the messages live in config/emailVerification.ts so validation and use
  // cannot disagree about what "configured" means.
  //
  // It also reports NOTHING for a PARTIALLY supplied service account: validation
  // should name the variable the operator must actually fix first, and the
  // Firebase problems above already do. Messages name variable NAMES only and
  // never a value, so the pepper can never be printed by a validation failure.
  problems.push(...emailVerificationPepperProblems(values));

  return problems;
}

export default { validateProductionConfig, JWT_SECRET_MIN_LENGTH };
