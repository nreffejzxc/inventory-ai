import { forwardRef, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { ComponentRef, ReactNode } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import type { TextInputProps } from 'react-native';
import { useKeyboardScroll } from './KeyboardScrollView';
import { radius, spacing, type } from '../lib/theme';
import type { Palette } from '../lib/theme';
import { useTheme } from '../lib/theme-context';
import IconButton from './IconButton';

const createStyles = (colors: Palette) =>
  StyleSheet.create({
    wrap: { marginBottom: spacing.lg },
    label: {
      ...type.label,
      color: colors.text,
      marginBottom: spacing.xs + 2,
    },
    req: { color: colors.danger },
    input: {
      ...type.body,
      color: colors.text,
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.borderStrong,
      borderRadius: radius.md,
      paddingHorizontal: spacing.md,
      paddingVertical: 11,
    },
    focused: { borderColor: colors.primary },
    multiline: {
      minHeight: 92,
      textAlignVertical: 'top',
    },
    inputError: { borderColor: colors.danger },
    inputDisabled: { backgroundColor: colors.surfaceMuted, color: colors.textMuted },
    // The positioned wrapper a SECRET field's trailing control sits in, and the
    // room that control needs so long secrets never run underneath it. Both apply
    // only when `secureTextEntry` is set; a non-secret field renders the bare input
    // it always did (see the render below).
    fieldWrap: { position: 'relative' },
    secretInput: { paddingRight: 52 },
    // `top`/`bottom` stretch the control to the field's own height, so the 44px
    // target `IconButton` guarantees is kept without inflating the input.
    toggle: { position: 'absolute', right: 2, top: 0, bottom: 0 },
    error: { ...type.caption, color: colors.danger, marginTop: 6 },
    helper: { ...type.caption, color: colors.textMuted, marginTop: 6 },
  });

export interface InputHandle {
  focus: () => void;
}

export interface InputProps {
  label?: ReactNode;
  /** Field key this input reports under; selects the matching `errors` entry. */
  name?: string;
  value?: string;
  onChangeText?: (text: string) => void;
  /** A single field message (wins over `errors`). */
  error?: string | null;
  /** Field-level problems from a 400 response, keyed by field name. */
  errors?: Record<string, string | undefined> | null;
  required?: boolean;
  placeholder?: string;
  secureTextEntry?: boolean;
  keyboardType?: TextInputProps['keyboardType'];
  autoCapitalize?: TextInputProps['autoCapitalize'];
  autoCorrect?: boolean;
  multiline?: boolean;
  editable?: boolean;
  maxLength?: number;
  helper?: ReactNode;
  returnKeyType?: TextInputProps['returnKeyType'];
  onSubmitEditing?: TextInputProps['onSubmitEditing'];
  onBlur?: () => void;
  autoFocus?: boolean;
  /**
   * What this field HOLDS, so the platform's own autofill can fill it.
   *
   * Passed straight through rather than re-declared as a project enum: the values are React
   * Native's (`current-password`, `new-password`, `one-time-code`, `sms-otp`, `email`, …) and a
   * copy of the union here would be a second list to keep in step.
   *
   * WHY IT MATTERS FOR THE AUTH SCREENS. A six-digit code is the one field a person cannot type
   * from memory: Android offers it as an autofill chip when the field declares `one-time-code`, and
   * iOS shows the code from Mail above the keyboard only when `textContentType` is `oneTimeCode`.
   * Without the declaration both platforms offer nothing, and the email has to be re-opened.
   */
  autoComplete?: TextInputProps['autoComplete'];
  /** The iOS half of the same declaration — see `autoComplete` above. */
  textContentType?: TextInputProps['textContentType'];
}

/**
 * Labelled text field. `error` renders the backend/field message; field-level
 * validation problems from a 400 map onto `name` and are shown in red.
 * Focused fields get a primary ring so the active input is obvious.
 */
const Input = forwardRef<InputHandle, InputProps>(function Input({
  label,
  name,
  value,
  onChangeText,
  error,
  errors = {},
  required,
  placeholder,
  secureTextEntry,
  keyboardType,
  autoCapitalize = 'none',
  autoCorrect = false,
  multiline,
  editable = true,
  maxLength,
  helper,
  returnKeyType,
  onSubmitEditing,
  onBlur,
  autoFocus,
  autoComplete,
  textContentType,
}, ref) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [focused, setFocused] = useState(false);
  // RN 0.88 no longer exposes the host instance through the `TextInput` value's type; the
  // ref's element type is the component's own instance type.
  const inputRef = useRef<ComponentRef<typeof TextInput>>(null);
  // A form can bring the member back to a field whose validation message would
  // otherwise be off-screen. Focusing it also triggers the keyboard-aware scroll
  // path below, so the message and the field arrive together.
  useImperativeHandle(ref, () => ({ focus: () => inputRef.current?.focus() }), []);
  /**
   * The keyboard fix, from the field's side: on focus, tell the nearest keyboard-aware
   * scroll view which field was focused so IT can bring it above the keyboard. Null on a
   * screen that does not scroll (a bottom-anchored layout lifts itself instead) and inside a
   * sheet whose own scroll view supplies its own registration — in both cases there is
   * nothing for this field to do, and nothing breaks.
   */
  const reportFocusToScrollView = useKeyboardScroll();

  /**
   * Phase 32N — whether this field's secret is currently REVEALED.
   *
   * COMPONENT-LOCAL, AND THAT IS THE WHOLE DESIGN. It is never lifted to a parent,
   * never persisted, never written to a log, never sent anywhere and never part of a
   * form's state: it changes only how THIS input renders the value it already holds.
   * So the value the parent owns, the validation that runs on it and the request
   * body built from it are identical whether the secret is showing or masked.
   *
   * It starts masked, and it is per-mount — a field is therefore never revealed by
   * default, and never revealed because some earlier screen left a toggle on.
   */
  const [revealed, setRevealed] = useState(false);
  const problem = error || errors?.[name ?? ''];

  /**
   * A field declares that it holds a secret by setting `secureTextEntry`, so that
   * prop — not a second, parallel flag — is what triggers the reveal control. Every
   * password field therefore gets one automatically, and a new one cannot be added
   * without one. A field that does not set it renders exactly as it always did.
   */
  const secure = Boolean(secureTextEntry);

  /**
   * The input, built once so the secure and non-secure branches below render the SAME
   * element rather than two that could drift apart. `secureTextEntry` keeps its
   * original value for a non-secret field; revealing only ever masks it off.
   */
  const field = (
    <TextInput
      ref={inputRef}
      style={[
        styles.input,
        multiline && styles.multiline,
        secure && styles.secretInput,
        focused && !problem && styles.focused,
        problem && styles.inputError,
        !editable && styles.inputDisabled,
      ]}
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={colors.placeholder}
      secureTextEntry={secureTextEntry && !revealed}
      keyboardType={keyboardType}
      autoCapitalize={autoCapitalize}
      autoCorrect={autoCorrect}
      editable={editable}
      multiline={multiline}
      maxLength={maxLength}
      returnKeyType={returnKeyType}
      onSubmitEditing={onSubmitEditing}
      autoComplete={autoComplete}
      textContentType={textContentType}
      onFocus={() => {
        setFocused(true);
        reportFocusToScrollView?.(inputRef.current);
      }}
      onBlur={() => {
        setFocused(false);
        onBlur?.();
      }}
      autoFocus={autoFocus}
    />
  );

  return (
    <View style={styles.wrap}>
      {label ? (
        <Text style={styles.label}>
          {label}
          {required ? <Text style={styles.req}> *</Text> : null}
        </Text>
      ) : null}
      {/**
       * The control is a SIBLING of the input inside a positioned wrapper, so the
       * field's border, focus ring and error colour still describe the input itself
       * while the toggle sits inside that border. Only a secret field gets the
       * wrapper — a non-secret one is rendered bare, with an unchanged element tree.
       */}
      {secure ? (
        <View style={styles.fieldWrap}>
          {field}
          <IconButton
            icon={revealed ? 'eyeOff' : 'eye'}
            accessibilityLabel={revealed ? 'Hide password' : 'Show password'}
            size={20}
            onPress={() => setRevealed((shown) => !shown)}
            style={styles.toggle}
          />
        </View>
      ) : (
        field
      )}
      {problem ? <Text style={styles.error}>{problem}</Text> : helper ? <Text style={styles.helper}>{helper}</Text> : null}
    </View>
  );
});

export default Input;
