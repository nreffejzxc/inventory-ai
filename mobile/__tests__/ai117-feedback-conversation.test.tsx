import { fireEvent, render, waitFor } from '@testing-library/react-native';

import { aiApi } from '../lib/api';
import { useSession } from '../lib/auth';
import { ThemeProvider } from '../lib/theme-context';

import AiFeedbackPreviewScreen from '../app/(app)/ai/feedback-preview';

/**
 * AI-117 — the complete-answer preview.
 *
 * The review-queue suite proves the report list and its excerpts. This suite
 * proves the explicit expansion: the reported answer is rendered in full, the
 * surrounding messages are visible, only OWNER/ADMIN reach it, and review is
 * still written through the same API.
 */

jest.mock('../lib/auth', () => ({ useSession: jest.fn(), isSessionError: () => false }));

jest.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  router: { back: jest.fn() },
  useLocalSearchParams: jest.fn(),
}));

jest.mock('../lib/api', () => ({
  aiApi: { feedbackConversation: jest.fn(), reviewFeedback: jest.fn() },
}));

const mockedUseSession = useSession as jest.Mock;
const feedbackConversation = aiApi.feedbackConversation as jest.Mock;
const reviewFeedback = aiApi.reviewFeedback as jest.Mock;
const useLocalSearchParams = jest.requireMock('expo-router').useLocalSearchParams as jest.Mock;

const FULL_ANSWER = `Complete answer. ${'detailed inventory row '.repeat(100)}`;

const PREVIEW = {
  feedback: {
    id: 'feedback-1',
    rating: 'DOWN',
    reason: 'INCORRECT_DATA',
    comment: 'The count is wrong.',
    status: 'OPEN',
    createdAt: '2026-11-15T08:00:00.000Z',
    reviewedAt: null,
    turnId: 'd7c73b39',
    messageId: 'm2',
    conversationId: 'c1',
    reportedBy: { id: 'u2', name: 'Sam Staff', role: 'STAFF' },
  },
  messages: [
    {
      id: 'm1',
      role: 'USER',
      content: 'How many Razer keyboards are in stock?',
      createdAt: '2026-11-15T07:59:00.000Z',
      reported: false,
    },
    {
      id: 'm2',
      role: 'ASSISTANT',
      content: FULL_ANSWER,
      createdAt: '2026-11-15T08:00:00.000Z',
      reported: true,
    },
    {
      id: 'm3',
      role: 'USER',
      content: 'And which location has the most?',
      createdAt: '2026-11-15T08:01:00.000Z',
      reported: false,
    },
  ],
  omittedBefore: false,
  omittedAfter: false,
};

const mount = async () =>
  await render(
    <ThemeProvider>
      <AiFeedbackPreviewScreen />
    </ThemeProvider>,
  );

beforeEach(() => {
  jest.clearAllMocks();
  useLocalSearchParams.mockReturnValue({ id: 'feedback-1' });
  mockedUseSession.mockReturnValue({
    user: { id: 'u1', name: 'Dana Owner', role: 'OWNER' },
    token: 'token',
    signOut: jest.fn(),
  });
  feedbackConversation.mockResolvedValue(PREVIEW);
  reviewFeedback.mockResolvedValue({ feedback: { id: 'feedback-1', status: 'REVIEWED' } });
});

describe('AI-117 — feedback conversation preview', () => {
  it('renders the complete reported answer and its surrounding messages', async () => {
    const screen = await mount();

    expect(await screen.findByText(FULL_ANSWER)).toBeTruthy();
    expect(screen.getByText('How many Razer keyboards are in stock?')).toBeTruthy();
    expect(screen.getByText('And which location has the most?')).toBeTruthy();
    expect(screen.getByText('Reported answer')).toBeTruthy();
    expect(screen.getByText('Bad response')).toBeTruthy();
    expect(screen.getByText('Incorrect data')).toBeTruthy();
    expect(screen.getByText('“The count is wrong.”')).toBeTruthy();
    expect(screen.getByText(/Sam Staff · Staff/)).toBeTruthy();
    expect(feedbackConversation).toHaveBeenCalledWith('token', 'feedback-1');
  });

  it('marks the report reviewed from the preview', async () => {
    const screen = await mount();
    await screen.findByText(FULL_ANSWER);

    fireEvent.press(screen.getByText('Mark reviewed'));

    await waitFor(() => {
      expect(reviewFeedback).toHaveBeenCalledWith('token', 'feedback-1', true);
      expect(feedbackConversation).toHaveBeenCalledTimes(2);
    });
  });

  it('denies the preview to a MANAGER and fetches nothing', async () => {
    mockedUseSession.mockReturnValue({
      user: { id: 'u2', name: 'Mia Manager', role: 'MANAGER' },
      token: 'token',
      signOut: jest.fn(),
    });

    const screen = await mount();

    expect(await screen.findByText(/Only the business owner and admins/i)).toBeTruthy();
    expect(feedbackConversation).not.toHaveBeenCalled();
  });
});
