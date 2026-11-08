/**
 * OpenRouter's built-in web tools.
 *
 * WHY THIS IS A SEPARATE MODULE. The two capabilities are operator switches, not
 * provider behaviour: a deployment may allow web search without allowing page
 * fetches, or the reverse. Keeping the parsing and the exact request objects here
 * means the provider, the startup diagnostics and `ai:check` cannot disagree about
 * what "enabled" means.
 *
 * BOTH DEFAULT TO DISABLED. The tools can add provider charges on top of the model
 * call, and existing deployments must keep the exact request they had before this
 * feature existed. An unrecognised value also stays DISABLED and is reported, so a
 * typo can never silently buy a search or a fetch.
 *
 * These are OpenRouter *server tools* (the current API), not the deprecated
 * `plugins: [{ id: 'web' }]` form. OpenRouter executes them and returns their
 * results to the model inside the same request.
 */

export type OpenRouterServerTool = {
  type: 'openrouter:web_search' | 'openrouter:web_fetch';
};

export interface WebCapabilityProblem {
  variable: string;
  message: string;
}

export interface WebCapabilities {
  searchEnabled: boolean;
  fetchEnabled: boolean;
  /** The tools to add to a normal assistant request, in stable order. */
  serverTools: OpenRouterServerTool[];
  problems: WebCapabilityProblem[];
}

const SEARCH_VARIABLE = 'AI_WEB_SEARCH';
const FETCH_VARIABLE = 'AI_WEB_FETCH';

const ENABLED = new Set(['enable', 'enabled', 'on', 'true', 'yes', '1']);
const DISABLED = new Set(['disable', 'disabled', 'off', 'false', 'no', '0']);

function parseSwitch(
  variable: string,
  raw: string | undefined,
): { enabled: boolean; problem?: WebCapabilityProblem } {
  const value = String(raw ?? '').trim().toLowerCase();
  if (!value) return { enabled: false };
  if (ENABLED.has(value)) return { enabled: true };
  if (DISABLED.has(value)) return { enabled: false };
  return {
    enabled: false,
    problem: {
      variable,
      // Never include the value: this is configuration, but the same messages
      // are safe to write to a boot log and a public check output.
      message: `${variable} must be enable or disable; the tool stays disabled.`,
    },
  };
}

/**
 * Read both switches from the environment.
 *
 * A plain object parameter keeps this testable without mutating the process
 * environment; the default is the live environment, matching `aiConfig()`.
 */
export function webCapabilities(
  env: Record<string, string | undefined> = process.env,
): WebCapabilities {
  const search = parseSwitch(SEARCH_VARIABLE, env[SEARCH_VARIABLE]);
  const fetch = parseSwitch(FETCH_VARIABLE, env[FETCH_VARIABLE]);
  const serverTools: OpenRouterServerTool[] = [];

  if (search.enabled) serverTools.push({ type: 'openrouter:web_search' });
  if (fetch.enabled) serverTools.push({ type: 'openrouter:web_fetch' });

  return {
    searchEnabled: search.enabled,
    fetchEnabled: fetch.enabled,
    serverTools,
    problems: [search.problem, fetch.problem].filter(
      (problem): problem is WebCapabilityProblem => Boolean(problem),
    ),
  };
}
