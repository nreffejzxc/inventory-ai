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
  /** OpenRouter's per-tool controls, including the hard per-request use cap. */
  parameters?: Record<string, unknown>;
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

export type WebToolName = 'search' | 'fetch';

const WEB_TOOL_ORDER: readonly WebToolName[] = ['search', 'fetch'];

/** The stable, human-readable label used by the request log. */
export function webToolLabel(names: readonly WebToolName[]): string {
  const present = new Set(names);
  return WEB_TOOL_ORDER.filter((name) => present.has(name)).join(',') || 'none';
}

/** The configured server tools, reduced to the two capability names. */
export function webToolNames(tools: readonly OpenRouterServerTool[]): WebToolName[] {
  const names = new Set<WebToolName>();
  for (const tool of tools) {
    if (tool.type === 'openrouter:web_search') names.add('search');
    else if (tool.type === 'openrouter:web_fetch') names.add('fetch');
  }
  return WEB_TOOL_ORDER.filter((name) => names.has(name));
}

/**
 * Capabilities the provider actually exercised in one response.
 *
 * The Anthropic wire returns a `server_tool_use` block (`name: web_search` or
 * `web_fetch`) followed by a matching `web_*_tool_result` block. Only those
 * type/name labels are inspected: the query, URL, page and result payload never
 * reach this function, so they can never reach a log. The usage counters are a
 * second signal for a gateway that omits the content blocks but still reports
 * that it ran a server tool.
 */
export function webToolsUsedFromResponse(content: unknown, usage: unknown): WebToolName[] {
  const used = new Set<WebToolName>();

  if (Array.isArray(content)) {
    for (const raw of content) {
      if (!raw || typeof raw !== 'object') continue;
      const block = raw as Record<string, unknown>;
      const type = typeof block.type === 'string' ? block.type.toLowerCase() : '';
      if (type === 'server_tool_use') {
        const name = typeof block.name === 'string' ? block.name.toLowerCase() : '';
        if (name.includes('web_search')) used.add('search');
        else if (name.includes('web_fetch')) used.add('fetch');
        continue;
      }
      if (type.includes('web_search')) used.add('search');
      else if (type.includes('web_fetch')) used.add('fetch');
    }
  }

  const usageObject = usage && typeof usage === 'object' ? (usage as Record<string, unknown>) : null;
  // OpenRouter reports the current shape as `server_tool_use_details`; some
  // Anthropic-compatible responses have used the shorter `server_tool_use`.
  // Read both so a successful native search is not mistaken for an ungrounded
  // answer, which would trigger a second provider request for the same turn.
  const serverUsage =
    usageObject?.server_tool_use_details && typeof usageObject.server_tool_use_details === 'object'
      ? (usageObject.server_tool_use_details as Record<string, unknown>)
      : usageObject?.server_tool_use && typeof usageObject.server_tool_use === 'object'
        ? (usageObject.server_tool_use as Record<string, unknown>)
        : null;
  if (serverUsage) {
    if (typeof serverUsage.web_search_requests === 'number' && serverUsage.web_search_requests > 0) {
      used.add('search');
    }
    if (typeof serverUsage.web_fetch_requests === 'number' && serverUsage.web_fetch_requests > 0) {
      used.add('fetch');
    }
  }

  return WEB_TOOL_ORDER.filter((name) => used.has(name));
}

/**
 * AI-86 — does this turn ask for something that genuinely lives on the public web?
 *
 * This is deliberately conservative. It is a gate for whether the PAID server tools may
 * be offered at all, not a classifier that has to be clever: a false negative is safe
 * because the inventory tools still answer, and the member can explicitly ask for a web
 * search. It must never turn a normal inventory question ("review my stock", "what is
 * the price of this product", "show low stock") into a billable web call. The model still
 * decides whether to use an offered tool; this only removes the temptation on turns that
 * plainly do not need the public web.
 */
const WEB_RESEARCH_INTENT =
  /\b(?:web|internet|google|bing|url|website|web\s*page|webpage)\b|https?:\/\/|\b(?:search|look\s+up|check|find)\s+(?:the\s+)?(?:web|internet|online)\b|\b(?:fetch|read)\s+(?:the\s+)?(?:web\s*page|page|url)\b|\b(?:product|owner|customer|user|online)\s+reviews?\b|\breviews\s+(?:of|for|on)\b|\breviews\b|\b(?:quality|reliability|well[- ]reviewed)\b|\b(?:market|marketplace|online|retail|competitor|current)\s+(?:prices?|pricing)\b|\bprices?\s+(?:online|elsewhere|comparison)\b|\bcheaper\s+elsewhere\b|\bprice\s+comparison\b|\b(?:shopee|lazada|amazon|ebay)\b|\bresearch\b|\bsources?\b|\bnews\b|\b(?:latest|newest|newer)\s+(?:model|version|price|review|news)\b|\bup[- ]to[- ]date\b|\b(?:product|brand)\s+recommendations?\b|\brecommend\s+(?:a|some|any)\s+(?:product|brand|model)\b|\b(?:search|find|look\s+up)\s+(?:for\s+)?(?:the\s+)?(?:product|item)\s+prices?\b/i;

/**
 * A source lock is a constraint, not a preference. These are the shapes a member uses
 * when they want the answer taken from their own records only; none of them may be
 * overridden by another research-sounding word in the same message.
 */
const INVENTORY_ONLY_INTENT = new RegExp(
  [
    String.raw`\b(?:using|use|from|based\s+on|according\s+to|check(?:ing)?|look(?:ing)?\s+at|search(?:ing)?)\s+only\s+(?:my|our|the)\s+(?:inventory|records?|stock|catalogue|catalog|database|app)\b`,
    String.raw`\b(?:based|use|using)\s+(?:only|solely|exclusively)\s+on\s+(?:my|our|the)\s+(?:inventory|records?|stock|catalogue|catalog|database|app)\b`,
    String.raw`\b(?:use|using)\s+only\s+(?:the\s+)?(?:data|information)\s+(?:in|from)\s+(?:my|our|the)\s+(?:inventory|records?|database|app)\b`,
    String.raw`\b(?:only|solely|exclusively)\s+(?:use|using|from|check|look\s+at|search)\b[^.!?\n]{0,40}\b(?:my|our|the)\s+(?:inventory|records?|stock|catalogue|catalog|database|app)\b`,
    String.raw`\b(?:only|solely|exclusively)\s+(?:my|our|the)\s+(?:inventory|records?|stock|catalogue|catalog|database|app)\b`,
    String.raw`\b(?:my|our|the)\s+(?:inventory|records?|stock|catalogue|catalog|database|app)\s+only\b`,
    String.raw`\b(?:inventory|records?|stock|catalogue|catalog)[- ]only\b`,
    String.raw`\b(?:do\s+not|don't|dont|never)\s+(?:use|using|search|searching|check|checking|consult|consulting|look\s+up|looking\s+up|access|accessing|browse|browsing)\s+(?:the\s+)?(?:web|internet|online|google)\b`,
    String.raw`\b(?:do\s+not|don't|dont|never)\s+(?:use|search|check|consult)\s+(?:the\s+)?(?:web|internet|online)\s+(?:prices?|data|sources?|research)\b`,
    String.raw`\b(?:no|without|ignore|ignoring|excluding)\s+(?:the\s+)?(?:web|internet|online)\s+(?:data|prices?|research|search|sources?)\b`,
    String.raw`\b(?:without|no)\s+(?:the\s+)?(?:web|internet|online)\b`,
    String.raw`\b(?:recorded|inventory)\s+(?:data|records?|information)\s+only\b`,
  ].join('|'),
  'i',
);

export function asksForInventoryOnly(message: string): boolean {
  const text = String(message ?? '');
  return INVENTORY_ONLY_INTENT.test(text);
}

/**
 * Price, supplier and review questions are the shapes that were measured using the web
 * while the member was asking about their own business. They are inventory questions by
 * default; public-web research needs an explicit external cue ("online", "market price",
 * a named marketplace, a URL, or "product reviews"). This is intentionally stricter than
 * the old keyword gate: "current price", "supplier" and "quality" no longer opt a turn
 * into a paid web search on their own.
 */
const SOURCE_SENSITIVE_INTENT =
  /\b(?:prices?|pricing|costs?|cost\s+price|selling\s+price|charge|cheaper|affordab(?:le|ility)|suppliers?|vendors?|distributors?|wholesalers?|lead\s+times?|moq|minimum\s+order|reviews|ratings?|quality|reliability|well[- ]reviewed|feedback)\b/i;

const EXPLICIT_EXTERNAL_SOURCE =
  /\b(?:web|internet|online|google|public|external|market(?:place)?|market\s+prices?|market\s+pricing|retail|competitor|elsewhere|shopee|lazada|amazon|ebay|website|web\s*page|webpage)\b|\b(?:product|owner|customer|user|public)\s+reviews?\b|\b(?:search|look\s+up|check|find|fetch|read|browse)\b[^.!?\n]{0,40}\b(?:online|web|internet|site|url|page)\b|https?:\/\//i;

export function asksForSourceSensitiveQuestion(message: string): boolean {
  return SOURCE_SENSITIVE_INTENT.test(String(message ?? ''));
}

export function asksForWebResearch(message: string): boolean {
  const text = String(message ?? '');
  if (asksForInventoryOnly(text)) return false;
  // For prices, suppliers and reviews the explicit external cue is the whole decision:
  // "suppliers online" is research even without the word "web", while "current price"
  // or "supplier" alone stays an inventory read.
  if (asksForSourceSensitiveQuestion(text)) return EXPLICIT_EXTERNAL_SOURCE.test(text);
  return WEB_RESEARCH_INTENT.test(text);
}

/**
 * AI-87 — does this turn deserve the stronger research model?
 *
 * This is broader than the paid-tool gate only for comparisons and buying advice that
 * do not name the web. It is deliberately narrower than `asksForProductAdvice`: "best
 * selling product" is an inventory read, not research, and must stay on the cheaper
 * default. `asksForWebResearch` already covers reviews, market prices, recommendations
 * and explicit research.
 */
const RESEARCH_MODEL_INTENT =
  /\b(?:compare|comparison|versus|vs\.?)\b|\bwhich\b[^?.!]{0,60}\b(?:better|best)\b|\bshould\s+(?:i|we)\s+(?:buy|get|choose)\b/i;

export function asksForResearchModel(message: string): boolean {
  const text = String(message ?? '');
  return asksForWebResearch(text) || RESEARCH_MODEL_INTENT.test(text);
}

/**
 * Hard per-request cost ceilings. These are deliberately in the tool definition rather
 * than in a new environment variable: the user asked for one switch per capability, and
 * a deployment cannot accidentally remove the ceiling by forgetting a second setting.
 *
 * Search is billed per executed search (about $0.007 with the default Exa engine), and
 * fetch is billed per fetched page. Two of each covers a normal research round while
 * stopping a model that would otherwise keep searching. The limits are per provider
 * request; the intent gate and the tool-free answer round bound the whole turn.
 */
const WEB_SEARCH_TOOL: OpenRouterServerTool = {
  type: 'openrouter:web_search',
  parameters: { max_uses: 2, max_total_results: 10 },
};
const WEB_FETCH_TOOL: OpenRouterServerTool = {
  type: 'openrouter:web_fetch',
  parameters: { max_uses: 2, max_content_tokens: 30000 },
};

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

  if (search.enabled) serverTools.push(WEB_SEARCH_TOOL);
  if (fetch.enabled) serverTools.push(WEB_FETCH_TOOL);

  return {
    searchEnabled: search.enabled,
    fetchEnabled: fetch.enabled,
    serverTools,
    problems: [search.problem, fetch.problem].filter(
      (problem): problem is WebCapabilityProblem => Boolean(problem),
    ),
  };
}
