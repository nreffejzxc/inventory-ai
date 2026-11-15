import { fireEvent, render, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { MessageBubble } from '../components/AiChat';
import type { ChatRow } from '../components/AiChat';
import { ThemeProvider } from '../lib/theme-context';

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn() },
}));

jest.mock('../lib/api', () => ({ aiApi: { feedback: jest.fn() } }));

/**
 * AI-116 — every new answer states what it read, and Inspect shows the details.
 *
 * The compact line is the trust surface: a member should be able to see the
 * retrieval time, sources and count without opening anything. The panel is for
 * the filters, tool names and source URLs that would otherwise turn every answer
 * into a report.
 */

const withTheme = (node: ReactNode) => render(<ThemeProvider>{node}</ThemeProvider>);

const row = (over: Partial<ChatRow> = {}): ChatRow => ({
  key: 'm1',
  messageId: 'm1',
  role: 'assistant',
  content: '9 products in Keyboards & Mice need restocking.',
  createdAt: new Date(2026, 10, 15, 3, 49).toISOString(),
  turnId: 'd7c73b39',
  toolsUsed: ['getReorderNeededProducts'],
  answerContext: {
    retrievedAt: new Date(2026, 10, 15, 3, 48).toISOString(),
    tools: ['getReorderNeededProducts'],
    sources: ['Inventory records'],
    productCount: 9,
    total: 19,
    hasMore: true,
    filters: [
      { label: 'Category', value: 'Keyboards & Mice' },
      { label: 'Limit', value: '50' },
    ],
    webSources: [],
  },
  ...over,
});

describe('AI-116 — answer provenance', () => {
  it('★ puts the sources and count in one line without opening anything', async () => {
    const view = await withTheme(<MessageBubble item={row()} />);

    expect(view.getByTestId('chat-tools')).toHaveTextContent(
      'Inventory records · 9 products · Category Keyboards & Mice',
    );
    expect(view.getByText('3:49 AM')).toBeTruthy();
    expect(view.queryByTestId('chat-answer-context')).toBeNull();
    expect(view.getByTestId('chat-scope-inspect')).toBeTruthy();
  });

  it('★ Inspect names the time, tools, counts and every filter', async () => {
    const view = await withTheme(<MessageBubble item={row()} />);

    fireEvent.press(view.getByTestId('chat-scope-inspect'));
    await waitFor(() => expect(view.getByTestId('chat-answer-context')).toBeTruthy());

    expect(view.getByText(/Retrieved Nov 15, 2026/)).toBeTruthy();
    expect(view.getByText('Sources: Inventory records')).toBeTruthy();
    expect(view.getByText('Tools: Restock list')).toBeTruthy();
    expect(view.getByText('Products: 9 of 19 matching')).toBeTruthy();
    expect(view.getByText('Category: Keyboards & Mice')).toBeTruthy();
    expect(view.getByText('Limit: 50')).toBeTruthy();

    fireEvent.press(view.getByTestId('chat-scope-inspect'));
    await waitFor(() => expect(view.queryByTestId('chat-answer-context')).toBeNull());
  });

  it('states when an answer read no data, instead of implying a stock read', async () => {
    const view = await withTheme(
      <MessageBubble
        item={row({
          toolsUsed: undefined,
          answerContext: {
            retrievedAt: new Date(2026, 10, 15, 3, 48).toISOString(),
            tools: [],
            sources: [],
            productCount: 0,
            total: null,
            hasMore: false,
            filters: [],
            webSources: [],
          },
        })}
      />,
    );

    expect(view.getByTestId('chat-tools')).toHaveTextContent('No data read');
    fireEvent.press(view.getByTestId('chat-scope-inspect'));
    await waitFor(() => expect(view.getByText('Tools: None')).toBeTruthy());
    expect(view.getByText('Products: 0')).toBeTruthy();
    expect(view.getByText('Filters: None')).toBeTruthy();
  });

  it('keeps the old Read label for a message stored before the context existed', async () => {
    const view = await withTheme(<MessageBubble item={row({ answerContext: undefined })} />);

    expect(view.getByTestId('chat-tools')).toHaveTextContent('Read: Restock list');
    expect(view.queryByTestId('chat-scope-inspect')).toBeNull();
  });
});
