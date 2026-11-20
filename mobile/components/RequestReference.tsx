import { useEffect, useMemo, useState } from 'react';
import { Clipboard, Pressable, StyleSheet, Text, View } from 'react-native';

import { isSafeRequestId } from '../lib/client';
import { radius, spacing, type } from '../lib/theme';
import type { Palette } from '../lib/theme';
import { useTheme } from '../lib/theme-context';

export interface RequestReferenceProps {
  requestId?: string | null;
  /** `start` fits a Banner; `center` fits ErrorState and empty states. */
  align?: 'start' | 'center';
}

/**
 * A copyable support reference. It renders only for a value that passes the
 * server's own safe-id rule, so an arbitrary or unsafe value cannot become UI.
 *
 * The copy confirmation is local and resets after two seconds. Nothing is stored,
 * sent, logged or attached to a success state: this is the one piece of diagnostic
 * evidence a member can hand to support without exposing a body, token, email
 * address or tenant data.
 */
export default function RequestReference({
  requestId,
  align = 'center',
}: RequestReferenceProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [copied, setCopied] = useState(false);
  const start = align === 'start';

  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  if (!isSafeRequestId(requestId)) return null;

  return (
    <View style={[styles.reference, start && styles.referenceStart]} testID="request-reference">
      <Text style={[styles.referenceText, start && styles.referenceTextStart]} selectable>
        Reference: {requestId}
      </Text>
      <Pressable
        testID="request-reference-copy"
        accessibilityRole="button"
        accessibilityLabel={copied ? 'Reference copied' : 'Copy request reference'}
        onPress={() => {
          try {
            Clipboard.setString(requestId);
            setCopied(true);
          } catch {
            // Copy is best-effort; the reference remains selectable on screen.
          }
        }}
        style={({ pressed }) => [styles.referenceCopy, pressed && { opacity: 0.7 }]}
      >
        <Text style={styles.referenceCopyText}>{copied ? 'Copied' : 'Copy'}</Text>
      </Pressable>
    </View>
  );
}

const createStyles = (colors: Palette) =>
  StyleSheet.create({
    reference: { marginTop: spacing.md, alignItems: 'center', gap: spacing.xs },
    referenceStart: { alignItems: 'flex-start', marginTop: spacing.sm },
    referenceText: { ...type.bodySmall, color: colors.textMuted, textAlign: 'center' },
    referenceTextStart: { textAlign: 'left' },
    referenceCopy: {
      minHeight: 44,
      justifyContent: 'center',
      paddingHorizontal: spacing.sm,
      borderRadius: radius.sm,
    },
    referenceCopyText: { ...type.bodySmall, color: colors.primary, fontWeight: '600' },
  });
