import { render } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { MessageBubble, toRow } from '../components/AiChat';
import type { ChatRow } from '../components/AiChat';
import { ThemeProvider } from '../lib/theme-context';

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn() },
}));

/**
 * The AI turn reference is support's handle on one answer.
 *
 * Every monitoring line for a turn — the request, each model call, the result — carries the
 * same short id, so the member can read one value off the answer they are asking about and
 * support can find the exact turn in the logs. It is drawn on the stored ASSISTANT message,
 * which is why a thread reopened later still shows it: the id would be useless if it existed
 * only while the reply was arriving.
 */

const withTheme = (node: ReactNode) => render(<ThemeProvider>{node}</ThemeProvider>);

const row = (over: Partial<ChatRow> = {}): ChatRow => ({
  key: 'm1',
  role: 'assistant',
  content: 'Nothing is low on stock.',
  ...over,
});

describe('the AI turn reference is readable from the app', () => {
  it('★ shows the turn id on an assistant answer', async () => {
    const { getByTestId } = await withTheme(<MessageBubble item={row({ turnId: 'f0dc8264' })} />);

    expect(getByTestId('chat-turn-ref').props.children).toContain('f0dc8264');
  });

  it('is drawn only on an assistant answer that carries one', async () => {
    const question = await withTheme(<MessageBubble item={row({ role: 'user', turnId: 'f0dc8264' })} />);
    expect(question.queryByTestId('chat-turn-ref')).toBeNull();

    const legacy = await withTheme(<MessageBubble item={row()} />);
    expect(legacy.queryByTestId('chat-turn-ref')).toBeNull();
  });

  it('keeps the id through the mapping a reloaded thread uses', () => {
    expect(
      toRow({ id: 'm1', role: 'ASSISTANT', content: 'Nothing is low on stock.', turnId: 'f0dc8264' }),
    ).toMatchObject({ turnId: 'f0dc8264' });
  });
});
