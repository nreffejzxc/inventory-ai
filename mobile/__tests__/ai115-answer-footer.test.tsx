import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { MessageBubble } from '../components/AiChat';
import type { ChatRow } from '../components/AiChat';
import { aiApi } from '../lib/api';
import { ThemeProvider } from '../lib/theme-context';

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn() },
}));

jest.mock('../lib/api', () => ({
  aiApi: { feedback: jest.fn() },
}));

const feedbackApi = aiApi.feedback as jest.Mock;

/**
 * AI-115 — the answer footer is one quiet action bar, not a stack of links.
 *
 * The reference design put an answer's actions in a compact icon-led row and kept the
 * metadata out of the way. This suite pins the parts that make that more than a restyle:
 * both actions stay reachable, the provenance and clock remain readable, and the support
 * reference does not occupy every answer until the member asks for it.
 */

const withTheme = (node: ReactNode) => render(<ThemeProvider>{node}</ThemeProvider>);

beforeEach(() => {
  feedbackApi.mockReset();
});

const at = (hours: number, minutes: number) => new Date(2026, 10, 15, hours, minutes).toISOString();

const row = (over: Partial<ChatRow> = {}): ChatRow => ({
  key: 'm1',
  messageId: 'm1',
  role: 'assistant',
  content: '9 products in Keyboards & Mice need restocking.',
  createdAt: at(3, 49),
  turnId: 'd7c73b39',
  toolsUsed: ['getReorderNeededProducts'],
  answerActions: {
    screens: [{ kind: 'restock', label: 'Restock', path: '/restock?category=keyboards' }],
  },
  ...over,
});

describe('AI-115 — assistant answer footer', () => {
  it('★ keeps the actions in one footer and the metadata in one quiet line', async () => {
    const { getByTestId, getByText, queryByTestId } = await withTheme(<MessageBubble item={row()} />);

    expect(getByTestId('chat-answer-footer')).toBeTruthy();
    expect(getByText('Copy')).toBeTruthy();
    expect(getByText('Open Restock')).toBeTruthy();
    expect(getByText('Read: Restock list')).toBeTruthy();
    expect(getByText('3:49 AM')).toBeTruthy();

    // The reference is support's detail, not part of every answer.
    expect(queryByTestId('chat-turn-ref')).toBeNull();
  });

  it('★ reveals the reference on request and hides it again', async () => {
    const view = await withTheme(<MessageBubble item={row()} />);

    fireEvent.press(view.getByTestId('chat-answer-details'));
    await waitFor(() => expect(view.getByTestId('chat-turn-ref')).toBeTruthy());
    expect(view.getByTestId('chat-turn-ref').props.children).toContain('d7c73b39');

    fireEvent.press(view.getByTestId('chat-answer-details'));
    await waitFor(() => expect(view.queryByTestId('chat-turn-ref')).toBeNull());
  });

  it('still keeps the server-provided screen destination', async () => {
    const { getByTestId } = await withTheme(<MessageBubble item={row()} />);

    expect(getByTestId('chat-screen-restock')).toBeTruthy();
  });

  it('does not draw a details control when the server sent no reference', async () => {
    const { queryByTestId } = await withTheme(<MessageBubble item={row({ turnId: undefined })} />);

    expect(queryByTestId('chat-answer-details')).toBeNull();
    expect(queryByTestId('chat-turn-ref')).toBeNull();
  });

  it('★ rates a good answer and shows the acknowledgement', async () => {
    feedbackApi.mockResolvedValue({
      feedback: { id: 'f1', rating: 'UP', reason: null, comment: null, status: 'OPEN' },
    });
    const view = await withTheme(<MessageBubble item={row()} token="token-1" />);

    await act(async () => {
      fireEvent.press(view.getByTestId('chat-feedback-up'));
    });

    await waitFor(() =>
      expect(feedbackApi).toHaveBeenCalledWith(
        'token-1',
        'm1',
        expect.objectContaining({ rating: 'UP' }),
      ),
    );
    expect(view.getByTestId('chat-feedback-thanks')).toBeTruthy();
  });

  it('★ reports a bad answer with a reason and an optional note', async () => {
    feedbackApi.mockResolvedValue({
      feedback: {
        id: 'f2',
        rating: 'DOWN',
        reason: 'INCORRECT_DATA',
        comment: 'Wrong count',
        status: 'OPEN',
      },
    });
    const view = await withTheme(<MessageBubble item={row()} token="token-1" />);

    fireEvent.press(view.getByTestId('chat-feedback-down'));
    await waitFor(() => expect(view.getByTestId('chat-feedback-form')).toBeTruthy());
    fireEvent.press(view.getByTestId('chat-feedback-reason-INCORRECT_DATA'));
    await waitFor(() =>
      expect(
        view.getByTestId('chat-feedback-reason-INCORRECT_DATA').props.accessibilityState.selected,
      ).toBe(true),
    );
    fireEvent.changeText(view.getByTestId('chat-feedback-comment'), 'Wrong count');
    await waitFor(() =>
      expect(view.getByTestId('chat-feedback-comment').props.value).toBe('Wrong count'),
    );
    await act(async () => {
      fireEvent.press(view.getByTestId('chat-feedback-send'));
    });

    await waitFor(() =>
      expect(feedbackApi).toHaveBeenCalledWith('token-1', 'm1', {
        rating: 'DOWN',
        reason: 'INCORRECT_DATA',
        comment: 'Wrong count',
      }),
    );
    expect(view.getByTestId('chat-feedback-thanks')).toBeTruthy();
  });

  it('★ shows an existing rating from a reloaded thread', async () => {
    const view = await withTheme(
      <MessageBubble
        item={row({
          feedback: {
            id: 'f3',
            rating: 'DOWN',
            reason: 'MISSING_INFORMATION',
            comment: 'The location is missing.',
            status: 'OPEN',
          },
        })}
        token="token-1"
      />,
    );

    await waitFor(() => expect(view.getByText('Reported — thank you.')).toBeTruthy());
    expect(view.getByTestId('chat-feedback-down').props.accessibilityState.selected).toBe(true);
    expect(view.getByTestId('chat-feedback-up').props.accessibilityState.selected).toBe(false);
  });
});
