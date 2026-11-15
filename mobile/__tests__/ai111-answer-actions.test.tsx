import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import { Clipboard } from 'react-native';
import type { ReactNode } from 'react';

import { MessageBubble } from '../components/AiChat';
import type { ChatRow } from '../components/AiChat';
import { answerPlainText } from '../lib/assistantMarkdown';
import { ThemeProvider } from '../lib/theme-context';

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn() },
}));

const withTheme = (node: ReactNode) => render(<ThemeProvider>{node}</ThemeProvider>);

const row = (over: Partial<ChatRow> = {}): ChatRow => ({
  key: 'm1',
  messageId: 'm1',
  role: 'assistant',
  content: '| Product | Available |\n|---|---|\n| Compact Kettle | 2 |',
  ...over,
});

const productLinks = [{ productId: 'p1', name: 'Compact Kettle', sku: 'KET-1' }];

describe('AI-111 — Copy Answer', () => {
  it('★ copies the whole answer as plain text, without table pipes', async () => {
    const spy = jest.spyOn(Clipboard, 'setString').mockImplementation(() => {});
    const { getByTestId, getByText } = await withTheme(<MessageBubble item={row()} />);

    fireEvent.press(getByTestId('chat-copy-answer'));

    expect(spy).toHaveBeenCalledWith('Product — Available\nCompact Kettle — 2');
    await waitFor(() => expect(getByText('Copied')).toBeTruthy());
    spy.mockRestore();
  });

  it('strips emphasis and preserves the facts in a copied answer', () => {
    expect(answerPlainText('**19 products** need restocking.\n\n- Compact Kettle: 2')).toBe(
      '19 products need restocking.\n\n- Compact Kettle: 2',
    );
  });

  it('does not offer copy on the member’s own message', async () => {
    const { queryByTestId } = await withTheme(
      <MessageBubble item={row({ role: 'user', content: 'Which products are low?' })} />,
    );
    expect(queryByTestId('chat-copy-answer')).toBeNull();
  });

  it('does not offer copy on an answer that is still streaming', async () => {
    const { queryByTestId } = await withTheme(
      <MessageBubble item={row({ messageId: undefined, content: 'Part of an answer' })} />,
    );
    expect(queryByTestId('chat-copy-answer')).toBeNull();
  });
});

describe('AI-111 — product navigation', () => {
  it('★ opens the exact server id when a product name in the answer is pressed', async () => {
    const { getByTestId } = await withTheme(
      <MessageBubble item={row({ productLinks })} />,
    );

    fireEvent.press(getByTestId('chat-product-link-p1'));
    expect(router.push).toHaveBeenCalledWith('/products/p1');
  });

  it('does not render a product link without server-provided ids', async () => {
    const { queryByTestId } = await withTheme(
      <MessageBubble item={row({ content: 'Compact Kettle has 2 available.' })} />,
    );
    expect(queryByTestId('chat-product-link-p1')).toBeNull();
  });

  it('does not make a product name pressable on the member’s own message', async () => {
    const { queryByTestId } = await withTheme(
      <MessageBubble
        item={row({ role: 'user', content: 'Tell me about Compact Kettle.', productLinks })}
      />,
    );
    expect(queryByTestId('chat-product-link-p1')).toBeNull();
  });
});