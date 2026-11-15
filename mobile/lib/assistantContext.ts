/**
 * Contextual assistant entry points.
 *
 * A product or stock screen can hand the member a question they would otherwise
 * have to compose from memory: the exact recorded product name, its SKU, and the
 * location they are already looking at. The prompt is only PREFILLED — it is
 * never sent automatically — so the member can review or change it before a
 * provider turn is spent.
 *
 * Keep the composer limit here so the route reader and the chat composer cannot
 * disagree about what fits. It mirrors the server's default `AI_MAX_MESSAGE_CHARS`.
 */
export const MAX_ASSISTANT_MESSAGE_CHARS = 4000;

type AssistantProduct = {
  name?: string | null;
  sku?: string | null;
};

type AssistantInventoryRow = {
  product?: AssistantProduct | null;
  location?: { name?: string | null } | null;
};

function readable(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** A ready-to-send question about one product's stock across every location. */
export function productAssistantPrompt(product: AssistantProduct | null | undefined): string {
  const name = readable(product?.name) || 'this product';
  const sku = readable(product?.sku);
  return `How much stock do we have for ${name}${sku ? ` (SKU ${sku})` : ''}, and at which locations?`;
}

/** A ready-to-send question about one product at the stock row's own location. */
export function inventoryAssistantPrompt(row: AssistantInventoryRow | null | undefined): string {
  const name = readable(row?.product?.name) || 'this product';
  const location = readable(row?.location?.name);
  return location
    ? `How much ${name} is available at ${location}, and is any of it reserved?`
    : `How much ${name} is available, and where is it held?`;
}

/**
 * Read the prompt route parameter safely.
 *
 * Expo Router types a repeated key as `string[]`; the first value is the one the
 * user followed. Trimming and capping here means an overlong or malformed deep
 * link cannot produce a composer value the server would reject.
 */
export function readAssistantPrompt(value: string | string[] | null | undefined): string {
  const first = Array.isArray(value) ? value[0] : value;
  return readable(first).slice(0, MAX_ASSISTANT_MESSAGE_CHARS);
}
