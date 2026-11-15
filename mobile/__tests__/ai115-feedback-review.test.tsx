import { fireEvent, render, waitFor } from '@testing-library/react-native';

import { aiApi } from '../lib/api';
import { useSession } from '../lib/auth';
import { ThemeProvider } from '../lib/theme-context';

import AiFeedbackScreen from '../app/(app)/ai/feedback';

/**
 * AI-115 — the review side of feedback.
 *
 * The footer suite proves a member can report an answer. This one mounts the
 * real queue screen and proves the other half: only OWNER/ADMIN reach it, the
 * bounded report is readable, and REVIEWED is written back through the API.
 */

jest.mock('../lib/auth', () => ({ useSession: jest.fn(), isSessionError: () => false }));

jest.mock('expo-router', () => {
  const Stack = { Screen: () => null };
  return {
    Stack,
    router: { push: jest.fn(), replace: jest.fn(), back: jest.fn() },
    useLocalSearchParams: () => ({}),
    useNavigation: () => ({ addListener: () => () => {} }),
    useFocusEffect: jest.fn(),
  };
});

jest.mock('../lib/api', () => ({
  aiApi: { feedbackList: jest.fn(), reviewFeedback: jest.fn() },
}));

const mockedUseSession = useSession as jest.Mock;
const feedbackList = aiApi.feedbackList as jest.Mock;
const reviewFeedback = aiApi.reviewFeedback as jest.Mock;

const REPORT = {
  id: 'feedback-1',
  rating: 'DOWN',
  reason: 'INCORRECT_DATA',
  comment: 'Wrong count for the Razer keyboard.',
  status: 'OPEN',
  turnId: 'd7c73b39',
  createdAt: '2026-11-15T08:00:00.000Z',
  reportedBy: { name: 'Sam Staff', role: 'STAFF' },
  question: { content: 'How many Razer keyboards are in stock?' },
  answer: {
    content: '19 products need restocking.',
    toolsUsed: ['getReorderNeededProducts'],
  },
};

const mount = async () =>
  await render(
    <ThemeProvider>
      <AiFeedbackScreen />
    </ThemeProvider>,
  );

beforeEach(() => {
  jest.clearAllMocks();
  mockedUseSession.mockReturnValue({
    user: { id: 'u1', name: 'Dana Owner', role: 'OWNER' },
    token: 'token',
    signOut: jest.fn(),
  });
  feedbackList.mockResolvedValue({
    items: [REPORT],
    page: 1,
    limit: 20,
    total: 1,
    totalPages: 1,
    summary: { total: 4, open: 2, up: 1, down: 3 },
  });
  reviewFeedback.mockResolvedValue({ feedback: { ...REPORT, status: 'REVIEWED' } });
});

describe('AI-115 — feedback review queue', () => {
  it('shows the bounded report, the member and the all-time summary', async () => {
    const screen = await mount();

    expect(await screen.findByText('Bad response')).toBeTruthy();
    expect(screen.getByText('Incorrect data')).toBeTruthy();
    expect(screen.getByText('“Wrong count for the Razer keyboard.”')).toBeTruthy();
    expect(screen.getByText(/Sam Staff · Staff/)).toBeTruthy();
    expect(screen.getByText('How many Razer keyboards are in stock?')).toBeTruthy();
    expect(screen.getByText('19 products need restocking.')).toBeTruthy();
    expect(screen.getByText('Read: getReorderNeededProducts')).toBeTruthy();
    expect(screen.getByText('Ref: d7c73b39')).toBeTruthy();
    expect(screen.getByText('Total')).toBeTruthy();
    expect(screen.getByText('Mark reviewed')).toBeTruthy();
  });

  it('marks the report reviewed through the API and reloads the queue', async () => {
    const screen = await mount();
    await screen.findByText('Bad response');

    fireEvent.press(screen.getByText('Mark reviewed'));

    await waitFor(() =>
      expect(reviewFeedback).toHaveBeenCalledWith('token', 'feedback-1', true),
    );
    await waitFor(() => expect(feedbackList).toHaveBeenCalledTimes(2));
  });

  it('denies the queue to a MANAGER and fetches nothing', async () => {
    mockedUseSession.mockReturnValue({
      user: { id: 'u2', name: 'Mia Manager', role: 'MANAGER' },
      token: 'token',
      signOut: jest.fn(),
    });

    const screen = await mount();

    expect(await screen.findByText(/Only the business owner and admins/i)).toBeTruthy();
    expect(feedbackList).not.toHaveBeenCalled();
  });
});
