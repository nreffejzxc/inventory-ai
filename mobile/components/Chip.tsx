import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import type { PressableProps } from 'react-native';
import { formatNumber } from '../lib/format';
import { radius, spacing, type } from '../lib/theme';
import type { Palette } from '../lib/theme';
import { useTheme } from '../lib/theme-context';

/** Selected chips take the primary tone; destructive filters take danger. */
export type ChipTone = 'primary' | 'danger';

const createStyles = (colors: Palette) =>
  StyleSheet.create({
    chip: {
      borderWidth: 1,
      borderColor: colors.borderStrong,
      backgroundColor: colors.surface,
      borderRadius: radius.pill,
      paddingHorizontal: spacing.md,
      minHeight: 44,
      justifyContent: 'center',
    },
    pressed: { opacity: 0.8 },
    label: { ...type.label },
  });

export interface ChipProps {
  label?: ReactNode;
  selected?: boolean;
  onPress?: PressableProps['onPress'];
  tone?: ChipTone;
  /** Server-backed total for this choice; omitted while counts are unavailable. */
  count?: number | null;
  /** Spoken by a screen reader; the visible label stays short. */
  accessibilityHint?: string;
}

/** Pressable filter chip (search/filter rows): toggles selection state. */
export default function Chip({ label, selected, onPress, tone = 'primary', count, accessibilityHint }: ChipProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const activeBg = tone === 'danger' ? colors.danger : colors.primary;
  const activeFg = colors.textOnPrimary;
  const visibleLabel =
    count == null
      ? label
      : typeof label === 'string'
        ? `${label} · ${formatNumber(count)}`
        : label;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: !!selected }}
      accessibilityLabel={typeof label === 'string' && count != null ? `${label}, ${formatNumber(count)} stock rows` : undefined}
      accessibilityHint={accessibilityHint}
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        selected && { backgroundColor: activeBg, borderColor: activeBg },
        pressed && styles.pressed,
      ]}
    >
      <Text style={[styles.label, selected ? { color: activeFg } : { color: colors.textSecondary }]} numberOfLines={1}>
        {visibleLabel}
      </Text>
    </Pressable>
  );
}
