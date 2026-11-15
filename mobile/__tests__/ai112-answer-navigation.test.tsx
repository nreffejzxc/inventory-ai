import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import type { ReactNode } from 'react';

import { MessageBubble } from '../components/AiChat';
import type { ChatRow } from '../components/AiChat';
import { ThemeProvider } from '../lib/theme-context';

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn() },
}));

const withTheme = (node: ReactNode) => render(<ThemeProvider>{node}</ThemeProvider>);

const rows = Array.from({ length: 12 }, (_, index) => ({
  productId: `p${index}`,
  title: `Product ${index}`,
  detail: `${index} available`,
}));

const row = (over: Partial<ChatRow> = {}): ChatRow => ({
  key: 'm1',
  messageId: 'm1',
  role: 'assistant',
  content: '19 products need restocking. Showing the first five.',
  answerActions: {
    list: { kind: 'restock', label: 'Restock', path: '/restock?q=kettle', total: 19, rows },
    screens: [{ kind: 'restock', label: 'Restock', path: '/restock?q=kettle' }],
  },
  ...over,
});

describe('AI-112 — complete list actions', () => {
  it('★ shows the total and reveals the next five captured results', async () => {
    const { getByTestId, queryByTestId, getByText } = await withTheme(<MessageBubble item={row()} />);

    expect(getByText('Showing 5 of 19 in this answer')).toBeTruthy();
    expect(getByTestId('chat-result-4')).toBeTruthy();
    expect(queryByTestId('chat-result-5')).toBeNull();

    fireEvent.press(getByTestId('chat-results-more'));
    await waitFor(() => expect(getByTestId('chat-result-9')).toBeTruthy());
    expect(queryByTestId('chat-result-10')).toBeNull();

    fireEvent.press(getByTestId('chat-results-more'));
    await waitFor(() => expect(getByTestId('chat-result-11')).toBeTruthy());
    expect(queryByTestId('chat-results-more')).toBeNull();
    expect(getByText('Showing 12 of 19 in this answer')).toBeTruthy();
  });

  it('opens the screen with the filters the tool actually used', async () => {
    const { getByTestId } = await withTheme(<MessageBubble item={row()} />);
    fireEvent.press(getByTestId('chat-screen-restock'));
    expect(router.push).toHaveBeenCalledWith('/restock?q=kettle');
  });

  it('opens a product from a result row using the server id', async () => {
    const { getByTestId } = await withTheme(<MessageBubble item={row()} />);
    fireEvent.press(getByTestId('chat-result-0'));
    expect(router.push).toHaveBeenCalledWith('/products/p0');
  });

  it('does not add a result panel when the answer is already the whole small list', async () => {
    const { queryByTestId } = await withTheme(
      <MessageBubble
        item={row({
          answerActions: {
            list: { kind: 'restock', label: 'Restock', path: '/restock', total: 3, rows: rows.slice(0, 3) },
            screens: [{ kind: 'restock', label: 'Restock', path: '/restock' }],
          },
        })}
      />,
    );
    expect(queryByTestId('chat-results')).toBeNull();
    expect(queryByTestId('chat-screen-restock')).toBeTruthy();
  });

  it('keeps the legacy restock affordance for stored answers without actions', async () => {
    const { getByTestId, queryByTestId } = await withTheme(
      <MessageBubble item={row({ answerActions: undefined, toolsUsed: ['getReorderNeededProducts'] })} />,
    );
    expect(queryByTestId('chat-screen-restock')).toBeNull();
    fireEvent.press(getByTestId('chat-restock-link'));
    expect(router.push).toHaveBeenCalledWith('/restock');
  });
});