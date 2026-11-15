import { useLocalSearchParams } from 'expo-router';

import AiChat from '../../../components/AiChat';
import Screen from '../../../components/Screen';
import { readAssistantPrompt } from '../../../lib/assistantContext';

/**
 * Start a brand-new AI conversation. The first message creates the
 * conversation server-side; AiChat keeps the returned id internally so every
 * follow-up in this screen continues the same thread.
 *
 * A product or stock screen may pass `prompt`, which fills the composer. It is
 * deliberately not auto-sent: the member sees the exact question first.
 */
export default function NewAiChatScreen() {
  const { prompt } = useLocalSearchParams<{ prompt?: string | string[] }>();

  return (
    <Screen padded={false}>
      <AiChat conversationId={null} initialPrompt={readAssistantPrompt(prompt)} />
    </Screen>
  );
}
