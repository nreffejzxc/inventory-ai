import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { radius, spacing } from '../lib/theme';
import type { Palette } from '../lib/theme';
import { useTheme } from '../lib/theme-context';
import RequestReference from './RequestReference';

/** The four tones a banner can be rendered in. */
export type BannerTone = 'error' | 'warn' | 'info' | 'success';

const createTones = (colors: Palette): Record<BannerTone, { bg: string; fg: string; border: string }> => ({
  error: { bg: colors.dangerSoft, fg: colors.danger, border: colors.danger },
  warn: { bg: colors.warningSoft, fg: colors.warning, border: colors.warning },
  info: { bg: colors.infoSoft, fg: colors.info, border: colors.info },
  success: { bg: colors.successSoft, fg: colors.success, border: colors.success },
});

export interface BannerProps {
  type?: BannerTone;
  text?: ReactNode;
  style?: StyleProp<ViewStyle>;
  /** The server's safe `X-Request-ID`, when this failure carried one. */
  requestId?: string | null;
}

/** Full-width alert strip for form/API errors above or below content. */
export default function Banner({ type = 'error', text, style, requestId }: BannerProps) {
  const { colors } = useTheme();
  const tones = useMemo(() => createTones(colors), [colors]);
  if (!text) return null;
  const t = tones[type] ?? tones.error;
  return (
    <View style={[styles.banner, { backgroundColor: t.bg, borderColor: t.border }, style]}>
      <Text style={[styles.text, { color: t.fg }]}>{text}</Text>
      <RequestReference requestId={requestId} align="start" />
    </View>
  );
}

const BODY = { fontSize: 13, lineHeight: 18 };

const styles = StyleSheet.create({
  banner: {
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    marginBottom: spacing.lg,
  },
  text: { ...BODY, fontWeight: '600' },
});
