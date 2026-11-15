import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import type { PressableProps, StyleProp, TextStyle, ViewStyle } from 'react-native';
import { radius, spacing, type } from '../lib/theme';
import type { Palette } from '../lib/theme';
import { useTheme } from '../lib/theme-context';
import { Icon } from './icons';
import type { IconName } from './icons';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';
export type ButtonSize = 'md' | 'lg';

const createVariants = (colors: Palette): Record<ButtonVariant, { bg: string; fg: string; border: string }> => ({
  primary: { bg: colors.primary, fg: colors.textOnPrimary, border: colors.primary },
  secondary: { bg: colors.surface, fg: colors.text, border: colors.borderStrong },
  danger: { bg: colors.danger, fg: colors.textOnPrimary, border: colors.danger },
  ghost: { bg: 'transparent', fg: colors.primary, border: 'transparent' },
});

const SIZES: Record<ButtonSize, { minHeight: number; paddingHorizontal: number }> = {
  md: { minHeight: 46, paddingHorizontal: spacing.lg },
  lg: { minHeight: 52, paddingHorizontal: spacing.xl },
};

export interface ButtonProps {
  title?: ReactNode;
  onPress?: PressableProps['onPress'];
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Semantic icon name (see components/icons). */
  icon?: IconName;
  loading?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  full?: boolean;
  textStyle?: StyleProp<TextStyle>;
  testID?: string;
}

/**
 * Primary action button. `size` is 'md' (46px, default) or 'lg' (52px) —
 * both comfortably above the 44px accessibility minimum. An optional `icon`
 * (semantic icon name) renders before the title.
 */
export default function Button({
  title,
  onPress,
  variant = 'primary',
  size = 'md',
  icon,
  loading = false,
  disabled = false,
  style,
  full = false,
  textStyle,
  testID,
}: ButtonProps) {
  const { colors } = useTheme();
  const variants = useMemo(() => createVariants(colors), [colors]);
  const v = variants[variant] ?? variants.primary;
  const isDisabled = disabled || loading;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      onPress={onPress}
      disabled={isDisabled}
      style={({ pressed }) => [
        styles.base,
        SIZES[size],
        { backgroundColor: v.bg, borderColor: v.border },
        full && styles.full,
        pressed && !isDisabled && { opacity: 0.85 },
        isDisabled && { opacity: 0.55 },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={v.fg} />
      ) : (
        <>
          {icon ? <Icon name={icon} size={18} color={v.fg} /> : null}
          <Text style={[styles.label, { color: v.fg }, icon && styles.labelWithIcon, textStyle]}>{title}</Text>
        </>
      )}
    </Pressable>
  );
}

export function ButtonRow({ children, style }: { children?: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.row, style]}>{children}</View>;
}

const styles = StyleSheet.create({
  base: {
    borderRadius: radius.md,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
  },
  full: { alignSelf: 'stretch' },
  label: {
    ...type.button,
    textAlign: 'center',
  },
  labelWithIcon: {
    marginLeft: spacing.sm,
  },
  row: {
    flexDirection: 'row',
    gap: spacing.md,
  },
});
