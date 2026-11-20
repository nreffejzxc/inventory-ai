import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { radius, spacing, type } from '../lib/theme';
import type { Palette } from '../lib/theme';
import { useTheme } from '../lib/theme-context';
import Sheet from './Sheet';

const createStyles = (colors: Palette) =>
  StyleSheet.create({
    wrap: { marginBottom: spacing.lg },
    label: { ...type.label, color: colors.text, marginBottom: spacing.xs + 2 },
    req: { color: colors.danger },
    field: {
      minHeight: 46,
      borderWidth: 1,
      borderColor: colors.borderStrong,
      borderRadius: radius.md,
      backgroundColor: colors.surface,
      paddingHorizontal: spacing.md,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    fieldPressed: { backgroundColor: colors.surfaceMuted },
    fieldFocused: { borderColor: colors.primary },
    fieldError: { borderColor: colors.danger },
    fieldDisabled: { backgroundColor: colors.surfaceMuted, opacity: 0.7 },
    value: { ...type.body, color: colors.text, flex: 1, paddingVertical: 11 },
    placeholder: { ...type.body, color: colors.placeholder, flex: 1, paddingVertical: 11 },
    chevron: { color: colors.textMuted, fontSize: 16, marginLeft: spacing.sm },
    error: { ...type.caption, color: colors.danger, marginTop: 6 },
    search: {
      ...type.body,
      color: colors.text,
      backgroundColor: colors.surfaceMuted,
      borderRadius: radius.md,
      marginHorizontal: spacing.lg,
      marginVertical: spacing.md,
      paddingHorizontal: spacing.md,
      paddingVertical: 8,
    },
    option: {
      paddingHorizontal: spacing.lg,
      paddingVertical: 15,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    optionPressed: { backgroundColor: colors.surfaceMuted },
    optionText: { ...type.body, color: colors.text, flex: 1 },
    optionSelected: { color: colors.primary, fontWeight: '700' },
    check: { color: colors.primary, fontWeight: '800', marginLeft: spacing.md },
    separator: { height: StyleSheet.hairlineWidth, backgroundColor: colors.divider, marginLeft: spacing.lg },
    empty: { ...type.body, color: colors.textMuted, textAlign: 'center', padding: spacing.xl },
  });

/** One row of a {@link SelectField}: the `value` is what `onChange` reports. */
export interface SelectOption {
  label: string;
  value: string;
}

export interface SelectFieldProps {
  label?: ReactNode;
  placeholder?: string;
  options: SelectOption[];
  value?: string;
  onChange?: (value: string) => void;
  error?: string | null;
  disabled?: boolean;
  required?: boolean;
  searchable?: boolean;
  /** Test handle for the trigger; the sheet keeps its own labels. */
  testID?: string;
}

/**
 * Read-only field that opens a bottom-sheet list of options. Keeps pickers
 * consistent across the app (product, location, category, movement type…)
 * without a picker library. `options` = [{ label, value }]; a value of ''
 * renders the placeholder. Sheet chrome is shared via the Sheet primitive.
 */
export default function SelectField({
  label,
  placeholder = 'Select…',
  options,
  value,
  onChange,
  error,
  disabled,
  required,
  searchable,
  testID,
}: SelectFieldProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  const [query, setQuery] = useState('');
  const selected = options.find((o) => o.value === value);
  const q = query.trim().toLowerCase();
  const shown = searchable && q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;

  return (
    <View style={styles.wrap}>
      {label ? (
        <Text style={styles.label}>
          {label}
          {required ? <Text style={styles.req}> *</Text> : null}
        </Text>
      ) : null}
      <Pressable
        testID={testID}
        accessibilityRole="button"
        onPress={() => {
          setQuery('');
          setOpen(true);
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        disabled={disabled || options.length === 0}
        style={({ pressed }) => [
          styles.field,
          focused && !error && !disabled && styles.fieldFocused,
          error && styles.fieldError,
          (disabled || options.length === 0) && styles.fieldDisabled,
          pressed && styles.fieldPressed,
        ]}
      >
        <Text numberOfLines={1} style={selected ? styles.value : styles.placeholder}>
          {selected ? selected.label : placeholder}
        </Text>
        <Text style={styles.chevron}>▾</Text>
      </Pressable>
      {error ? <Text style={styles.error}>{error}</Text> : null}

      <Sheet
        visible={open}
        onClose={() => setOpen(false)}
        title={label || 'Select'}
        closeLabel="Done"
      >
        {options.length === 0 ? (
          <Text style={styles.empty}>No options available.</Text>
        ) : (
          <FlatList
            data={shown}
            keyExtractor={(o) => o.value}
            keyboardShouldPersistTaps="handled"
            ListHeaderComponent={
              searchable ? (
                <TextInputInline value={query} onChangeText={setQuery} />
              ) : undefined
            }
            ListEmptyComponent={<Text style={styles.empty}>No matches.</Text>}
            renderItem={({ item }) => {
              const isSel = item.value === value;
              return (
                <Pressable
                  onPress={() => {
                    onChange?.(item.value);
                    setOpen(false);
                  }}
                  style={({ pressed }) => [styles.option, pressed && styles.optionPressed]}
                >
                  <Text style={[styles.optionText, isSel && styles.optionSelected]} numberOfLines={2}>
                    {item.label}
                  </Text>
                  {isSel ? <Text style={styles.check}>✓</Text> : null}
                </Pressable>
              );
            }}
            ItemSeparatorComponent={() => <View style={styles.separator} />}
          />
        )}
      </Sheet>
    </View>
  );
}

function TextInputInline({ value, onChangeText }: { value: string; onChangeText: (text: string) => void }) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <TextInput
      value={value}
      onChangeText={onChangeText}
      placeholder="Search…"
      placeholderTextColor={colors.placeholder}
      autoCapitalize="none"
      autoCorrect={false}
      style={styles.search}
    />
  );
}
