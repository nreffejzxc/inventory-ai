import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import type { ReactNode } from 'react';

import AssistantPromptCard from '../components/AssistantPromptCard';
import AiChat from '../components/AiChat';
import { aiApi } from '../lib/api';
import {
  MAX_ASSISTANT_MESSAGE_CHARS,
  inventoryAssistantPrompt,
  productAssistantPrompt,
  readAssistantPrompt,
} from '../lib/assistantContext';
import { useSession } from '../lib/auth';
import { ThemeProvider } from '../lib/theme-context';

/**
 * AI-110 — the assistant starts where the member already is.
 *
 * Product and stock screens know the exact row being looked at. Reaching the
 * assistant from there used to mean leaving the screen, opening the hub, starting
 * a chat and retyping the product and location — and retyping is how the wrong
 * variant gets discussed. These cases pin the two properties that make the
 * shortcut safe: the question is built from recorded fields, and it is prefilled,
 * not sent.
 */

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn() },
}));

jest.mock('../lib/auth', () => ({
  useSession: jest.fn(),
  isSessionError: jest.fn(() => false),
}));

jest.mock('../lib/api', () => ({
  aiApi: { chat: jest.fn(), chatStream: jest.fn(), messages: jest.fn() },
}));

const chat = aiApi.chat as jest.Mock;
const chatStream = aiApi.chatStream as jest.Mock;
const messages = aiApi.messages as jest.Mock;
const mockedUseSession = useSession as jest.Mock;
const push = router.push as jest.Mock;

const withTheme = (node: ReactNode) => render(<ThemeProvider>{node}</ThemeProvider>);

beforeEach(() => {
  jest.clearAllMocks();
  mockedUseSession.mockReturnValue({
    user: { id: 'u1', name: 'Test Member', role: 'MANAGER' },
    token: 'token-1',
    signOut: jest.fn(),
  });
  messages.mockResolvedValue({ items: [], total: 0 });
});

describe('AI-110 contextual assistant entry points', () => {
  it('builds a product question from the recorded name and SKU', () => {
    expect(productAssistantPrompt({ name: 'Compact Kettle', sku: 'CK-1' })).toBe(
      'How much stock do we have for Compact Kettle (SKU CK-1), and at which locations?',
    );
    expect(productAssistantPrompt({ name: '  Compact Kettle  ' })).toBe(
      'How much stock do we have for Compact Kettle, and at which locations?',
    );
  });

  it('builds a stock-row question from the product and its location', () => {
    expect(
      inventoryAssistantPrompt({
        product: { name: 'Compact Kettle' },
        location: { name: 'Main Warehouse' },
      }),
    ).toBe('How much Compact Kettle is available at Main Warehouse, and is any of it reserved?');
    expect(inventoryAssistantPrompt({ product: { name: 'Compact Kettle' } })).toBe(
      'How much Compact Kettle is available, and where is it held?',
    );
  });

  it('reads a route prompt safely, including repeated keys and the composer cap', () => {
    expect(readAssistantPrompt('  How much stock?  ')).toBe('How much stock?');
    expect(readAssistantPrompt(['First question', 'Second question'])).toBe('First question');
    expect(readAssistantPrompt(undefined)).toBe('');
    expect(readAssistantPrompt('x'.repeat(MAX_ASSISTANT_MESSAGE_CHARS + 100))).toHaveLength(
      MAX_ASSISTANT_MESSAGE_CHARS,
    );
  });

  it('★ opens a new chat with the question prepared, without sending it', async () => {
    const prompt = productAssistantPrompt({ name: 'Compact Kettle', sku: 'CK-1' });
    const view = await withTheme(
      <AssistantPromptCard prompt={prompt} title="Ask about this product" />,
    );

    fireEvent.press(view.getByText('Ask AI'));

    expect(push).toHaveBeenCalledWith({ pathname: '/ai/new', params: { prompt } });
    expect(chat).not.toHaveBeenCalled();
    expect(chatStream).not.toHaveBeenCalled();
  });

  it('★ fills the composer from the prepared question but spends no provider turn', async () => {
    const prompt = inventoryAssistantPrompt({
      product: { name: 'Compact Kettle' },
      location: { name: 'Main Warehouse' },
    });
    const view = await withTheme(<AiChat initialPrompt={prompt} />);

    await waitFor(() => expect(view.getByText('Ask about your inventory')).toBeTruthy());
    expect(view.getByPlaceholderText('Ask about your stock…').props.value).toBe(prompt);
    expect(chat).not.toHaveBeenCalled();
    expect(chatStream).not.toHaveBeenCalled();
    expect(messages).not.toHaveBeenCalled();
  });

  it('renders nothing for a blank prepared question', async () => {
    const view = await withTheme(<AssistantPromptCard prompt="   " />);
    expect(view.queryByText('Ask AI')).toBeNull();
  });
});
