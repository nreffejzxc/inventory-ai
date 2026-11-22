import { useMemo } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import type { StyleProp, TextInputProps, ViewStyle } from 'react-native';
import { radius, spacing, type } from '../lib/theme';
import type { Palette } from '../lib/theme';
import { useTheme } from '../lib/theme-context';
import { Icon } from './icons';

const createStyles = (colors: Palette) =>
  StyleSheet.create({
    wrap: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      backgroundColor: colors.surfaceMuted,
      borderRadius: radius.md,
      paddingHorizontal: spacing.md,
      minHeight: 44,
    },
    input: {
      ...type.body,
      flex: 1,
      color: colors.text,
      paddingVertical: 11,
    },
    scanButton: {
      width: 44,
      height: 44,
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: -spacing.sm,
    },
  });

export interface SearchFieldProps {
  value?: string;
  onChangeText?: (text: string) => void;
  placeholder?: string;
  autoCapitalize?: TextInputProps['autoCapitalize'];
  autoFocus?: boolean;
  /** Shows a barcode-scan action at the end of the field. */
  onScanPress?: () => void;
  style?: StyleProp<ViewStyle>;
}

/**
 * Search input used in list headers: search icon + text field on a muted
 * surface. Keeps a 44px touch target and stays readable at larger font sizes.
 * `autoCapitalize` defaults to 'none'; callers searching codes that are shown
 * in upper case (e.g. purchase-order numbers) can ask for 'characters'.
 */
function SearchField({
  value,
  onChangeText,
  placeholder = 'Search…',
  autoCapitalize = 'none',
  autoFocus,
  onScanPress,
  style,
}: SearchFieldProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <View style={[styles.wrap, style]}>
      <Icon name="search" size={18} color={colors.textMuted} />
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.placeholder}
        autoCapitalize={autoCapitalize}
        autoCorrect={false}
        autoFocus={autoFocus}
        returnKeyType="search"
      />
      {onScanPress ? (
        <Pressable
          onPress={onScanPress}
          accessibilityRole="button"
          accessibilityLabel="Scan a barcode"
          hitSlop={8}
          style={({ pressed }) => [styles.scanButton, pressed && { opacity: 0.7 }]}
        >
          <Icon name="scan" size={20} color={colors.primary} />
        </Pressable>
      ) : null}
    </View>
  );
}

export default SearchField;
