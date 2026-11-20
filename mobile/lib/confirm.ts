import { Alert, Clipboard } from 'react-native';

import { errorRequestId, errorText, requestReferenceText, withRequestReference } from './errors';

/**
 * Promise-based wrappers over React Native's Alert. Confirmations are used for
 * destructive actions (archive, sign out, cancel…) so users confirm before
 * irreversible changes. Resolves true when the user confirms, false when cancel.
 */
export interface ConfirmOptions {
  confirmText?: string;
  destructive?: boolean;
}

export function confirm(
  title: string,
  message: string,
  { confirmText = 'Confirm', destructive = false }: ConfirmOptions = {},
): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(title, message, [
      { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
      { text: confirmText, style: destructive ? 'destructive' : 'default', onPress: () => resolve(true) },
    ]);
  });
}

export interface AlertOptions {
  /** The server reference to show, and offer to copy, beside the message. */
  requestId?: string | null;
}

/**
 * Plain single-action alert. When a safe request reference is supplied it is
 * appended to the body and a second button copies exactly that value. Native
 * alert text is not selectable, so the button is what makes the reference
 * genuinely copyable rather than merely visible.
 */
export function alert(
  title: string,
  message: string,
  { requestId }: AlertOptions = {},
): Promise<boolean> {
  const referenceShown = requestReferenceText(requestId);
  return new Promise((resolve) => {
    const buttons = [
      ...(referenceShown
        ? [
            {
              text: 'Copy reference',
              onPress: () => {
                try {
                  Clipboard.setString(requestId as string);
                } catch {
                  // Copy is best-effort; the visible reference is still usable.
                }
                resolve(true);
              },
            },
          ]
        : []),
      { text: 'OK', onPress: () => resolve(true) },
    ];
    Alert.alert(title, withRequestReference(message, requestId), buttons, { cancelable: false });
  });
}

/**
 * The standard failure alert: the same message the screen would show, plus the
 * safely-read request id and its copy action. Unrelated failures (permissions,
 * print/share) pass through unchanged because they carry no reference.
 */
export function alertError(
  title: string,
  err: unknown,
  fallback = 'Something went wrong. Please try again.',
): Promise<boolean> {
  return alert(title, errorText(err, fallback), { requestId: errorRequestId(err) });
}
