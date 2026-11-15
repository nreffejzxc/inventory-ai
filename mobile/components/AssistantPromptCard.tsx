import { useMemo } from 'react';
import { router } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';

import Button from './Button';
import Card from './Card';
import { Icon } from './icons';
import { radius, spacing, type } from '../lib/theme';
import type { Palette } from '../lib/theme';
import { useTheme } from '../lib/theme-context';

export interface AssistantPromptCardProps {
  /** The question put in the new chat's composer. It is never sent automatically. */
  prompt: string;
  title?: string;
  description?: string;
  style?: StyleProp<ViewStyle>;
}

/**
 * A contextual door into the assistant.
 *
 * Product and stock screens already know the exact product, SKU and location the
 * member is looking at. Asking about that row used to mean leaving the screen,
 * opening the AI hub, starting a chat and retyping those details — and a retyped
 * name is how the wrong variant gets discussed. This card opens a new chat with
 * the question ready to review, without spending a provider turn until Send.
 */
export default function AssistantPromptCard({
  prompt,
  title = 'Ask the assistant',
  description = 'Opens a new chat with your question ready to send.',
  style,
}: AssistantPromptCardProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const question = prompt.trim();

  if (!question) return null;

  return (
    <Card style={[styles.card, style]}>
      <View style={styles.header}>
        <View style={styles.icon}>
          <Icon name="sparkles" color={colors.primary} size={22} />
        </View>
        <View style={styles.copy}>
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.description}>{description}</Text>
        </View>
      </View>
      <Button
        title="Ask AI"
        icon="sparkles"
        variant="secondary"
        full
        onPress={() => router.push({ pathname: '/ai/new', params: { prompt: question } })}
        style={styles.button}
      />
    </Card>
  );
}

const createStyles = (colors: Palette) =>
  StyleSheet.create({
    card: {
      backgroundColor: colors.primarySoft,
      borderColor: colors.primarySoft,
    },
    header: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
    icon: {
      width: 40,
      height: 40,
      borderRadius: radius.pill,
      backgroundColor: colors.surface,
      alignItems: 'center',
      justifyContent: 'center',
    },
    copy: { flex: 1 },
    title: { ...type.body, color: colors.primaryDark, fontWeight: '700' },
    description: { ...type.caption, color: colors.textSecondary, marginTop: 2 },
    button: { marginTop: spacing.md },
  });
