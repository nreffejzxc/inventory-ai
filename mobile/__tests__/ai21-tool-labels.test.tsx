import { fireEvent, render } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { MessageBubble } from '../components/AiChat';
import type { ChatRow } from '../components/AiChat';
import { ThemeProvider } from '../lib/theme-context';
import { toolLabel, toolTrace } from '../lib/toolLabels';

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn() },
}));

/**
 * AI-21 — the provenance chip speaks the member's language.
 *
 * THE DEFECT, from the phone 2026-10-19. Every answer ended with `Read: getProductsByLocation`
 * — an identifier from the server's tool table, shown as if it were a word. The owner's call:
 * say what was read, not which function read it.
 *
 * WHAT THIS SUITE PINS, in the two directions that matter:
 *   * no internal name can reach the screen — EVERY name in the server's table renders as
 *     something else, and a name the client has never seen is humanised rather than printed;
 *   * nothing that depends on the real names breaks — the restock link still keys off them,
 *     and the stored message is untouched (it is the server's record, not the chip's).
 *
 * The tool list below mirrors `server/src/services/ai/tools.ts` by hand. It is a mirror and
 * not a source of truth on purpose: a client test cannot import server TypeScript, and the
 * fallback is what makes a drifting mirror a cosmetic issue rather than a leak — but the
 * case fails if any of these eleven ever renders raw, which is the cheap half to check.
 */

const TOOL_NAMES = [
  'searchProducts',
  'getProduct',
  'getInventory',
  'getLowStockProducts',
  'getOutOfStockProducts',
  'getReorderNeededProducts',
  'getInventorySummary',
  'getInventoryHistory',
  'getProductsByLocation',
  'listLocations',
  'listCategories',
  'listBrands',
  // AI-23's read. Added when it shipped: the mirror is checked by hand, and a name missing
  // from it is exactly how an identifier would reach the screen unnoticed.
  'getLocationBreakdown',
];

const withTheme = (node: ReactNode) => render(<ThemeProvider>{node}</ThemeProvider>);

const row = (over: Partial<ChatRow> = {}): ChatRow => ({
  key: 'm1',
  role: 'assistant',
  content: 'Main Warehouse holds 203 product-location rows.',
  ...over,
});

describe('AI-21 tool names never reach the screen', () => {
  it('★ every server tool renders as a label, never the identifier', () => {
    for (const name of TOOL_NAMES) {
      const label = toolLabel(name);
      expect(label).not.toBe(name);
      // A humanised fallback would also satisfy "not equal", so the shape matters too: a
      // label has no camelCase hump and no leading get/list.
      expect(label).not.toMatch(/[a-z][A-Z]/);
      expect(label).not.toMatch(/^(get|list)/);
      expect(label.trim()).toBe(label);
      expect(label.length).toBeGreaterThan(2);
    }
  });

  it('★ the labels are the ones a member reads, not a hash of the names', () => {
    expect(toolLabel('getProductsByLocation')).toBe('Products at a location');
    expect(toolLabel('getInventoryHistory')).toBe('Stock movements');
    expect(toolLabel('getReorderNeededProducts')).toBe('Restock list');
    expect(toolLabel('listCategories')).toBe('Categories');
  });

  it('★ two labels are never the same, so a chip cannot be ambiguous', () => {
    const labels = TOOL_NAMES.map(toolLabel);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('★ a tool this build has never seen is humanised, not printed', () => {
    expect(toolLabel('getWidgetStats')).toBe('Widget stats');
    expect(toolLabel('listSomething_new')).toBe('Something new');
    // The total case: anything at all must produce a label rather than the raw string.
    for (const odd of ['', '_', '123', 'get']) {
      const label = toolLabel(odd);
      expect(label).not.toBe(odd);
      expect(label.length).toBeGreaterThan(2);
    }
  });

  it('★ a turn that called one tool twice says it once', () => {
    expect(toolTrace(['getInventory', 'getInventory'])).toBe('Inventory rows');
    expect(toolTrace(['getInventory', 'getInventoryHistory'])).toBe('Inventory rows · Stock movements');
    expect(toolTrace([])).toBeNull();
    expect(toolTrace(undefined)).toBeNull();
  });
});

describe('AI-21 the bubble shows the label and keeps the trace working', () => {
  it('★ the chip renders the label and never the raw name', async () => {
    const { getByTestId, queryByText } = await withTheme(
      <MessageBubble item={row({ toolsUsed: ['getProductsByLocation'] })} />,
    );

    const chip = getByTestId('chat-tools');
    expect(chip).toBeTruthy();
    expect(queryByText(/Products at a location/)).toBeTruthy();
    expect(queryByText(/getProductsByLocation/)).toBeNull();
  });

  it('★ the restock link still keys off the real name, beside the label', async () => {
    const { getByTestId } = await withTheme(
      <MessageBubble
        item={row({
          degraded: 'OUTPUT_LIMIT',
          toolsUsed: ['getReorderNeededProducts'],
          content: '1. Everyday Towel 60624 - available 416',
        })}
      />,
    );

    // The routing reads the stored name; the chip reads the label. Both must hold at once.
    expect(getByTestId('chat-restock-link')).toBeTruthy();
    expect(getByTestId('chat-tools')).toBeTruthy();
    fireEvent.press(getByTestId('chat-restock-link'));
  });

  it('does not draw a chip for a member’s own message or for a turn with no tools', async () => {
    const own = await withTheme(<MessageBubble item={row({ role: 'user', toolsUsed: ['getInventory'] })} />);
    expect(own.queryByTestId('chat-tools')).toBeNull();

    const none = await withTheme(<MessageBubble item={row()} />);
    expect(none.queryByTestId('chat-tools')).toBeNull();
  });
});
