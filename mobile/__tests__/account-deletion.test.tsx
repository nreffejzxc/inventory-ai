/**
 * Account deletion — the screen and its credential choice.
 *
 * WHY THIS SUITE EXISTS. Deletion is the one irreversible action in the app, and the
 * screen is where a person meets three rules that must not silently change:
 *
 *   1. NOTHING HAPPENS UNTIL THE WORD IS TYPED. The destructive button is disabled until
 *      the confirmation matches `DELETE`, and a blank or mistyped value is refused before
 *      a request is made — the server's budget is not spent on an accidental tap.
 *   2. THE CREDENTIAL IS THE ONE THE ACCOUNT HAS. A Firebase-linked account sends an ID
 *      token and is NOT asked for a password; a legacy account sends its password and no
 *      token. Neither is inferred from anything the person types.
 *   3. A REFUSAL IS SHOWN, NOT A SIGN-OUT. The last-owner 409, the wrong-password 400 and
 *      the no-identity case all leave the session intact; only a 401 ends it.
 *
 * `lib/auth` and `lib/api` are mocked; the screen composes the real Button, Card, Input,
 * Banner, Screen and theme, so the rendering asserted here is the shipped one.
 */

import { fireEvent, render, waitFor } from '@testing-library/react-native';

import { ApiError } from '../lib/client';
import { useSession } from '../lib/auth';
import { deleteAccount } from '../lib/api';
import { currentFirebaseIdToken } from '../lib/firebase-auth';
import { purgeProductImportDraft } from '../lib/productImportDraft';
import { ThemeProvider } from '../lib/theme-context';

import DeleteAccountScreen from '../app/(app)/delete-account';
import { router } from 'expo-router';

jest.mock('expo-router', () => {
  const { Text } = jest.requireActual('react-native');
  return {
    router: { replace: jest.fn(), push: jest.fn(), back: jest.fn() },
    Redirect: ({ href }: { href: string }) => <Text testID={'redirect:' + href} />,
    Stack: { Screen: () => null },
  };
});

jest.mock('../lib/auth', () => ({
  useSession: jest.fn(),
  isSessionError: jest.fn(() => false),
}));

jest.mock('../lib/api', () => ({
  deleteAccount: jest.fn(),
}));

jest.mock('../lib/firebase-auth', () => ({
  currentFirebaseIdToken: jest.fn(),
}));

jest.mock('../lib/productImportDraft', () => ({
  purgeProductImportDraft: jest.fn(async () => true),
}));

const mockUseSession = useSession as jest.Mock;
const mockDeleteAccount = deleteAccount as jest.Mock;
const mockIdToken = currentFirebaseIdToken as jest.Mock;
const mockPurgeDraft = purgeProductImportDraft as jest.Mock;

function signIn({ firebase }: { firebase: boolean }) {
  const signOut = jest.fn().mockResolvedValue(undefined);
  mockUseSession.mockReturnValue({
    token: 'session-token',
    user: { id: 'u1', name: 'Owner', authMethods: { password: true, firebase } },
    signOut,
  });
  return signOut;
}

async function renderScreen() {
  return render(
    <ThemeProvider>
      <DeleteAccountScreen />
    </ThemeProvider>
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockIdToken.mockResolvedValue('firebase-id-token');
  mockDeleteAccount.mockResolvedValue({ deleted: true, changed: true });
  mockPurgeDraft.mockResolvedValue(true);
});

describe('delete account screen', () => {
  it('states what is deleted and what stays before anything is pressed', async () => {
    signIn({ firebase: false });
    const screen = await renderScreen();

    expect(screen.getByText(/permanently closes your account/i)).toBeTruthy();
    expect(screen.getByText(/What is deleted/i)).toBeTruthy();
    expect(screen.getByText(/What stays/i)).toBeTruthy();
    expect(screen.getByText('If you are the only member')).toBeTruthy();
    // The consequence for a sole proprietor is stated BEFORE they commit: closing the
    // account of a business's only member closes the business too.
    expect(screen.getByText(/closes the business as well/i)).toBeTruthy();
    expect(screen.getByPlaceholderText('DELETE')).toBeTruthy();
  });

  it('★ will not submit until the confirmation word is typed', async () => {
    signIn({ firebase: false });
    const screen = await renderScreen();

    await fireEvent.changeText(screen.getByPlaceholderText('Your current password'), 'Password123!');
    await fireEvent.press(screen.getByText('Delete my account'));

    expect(mockDeleteAccount).not.toHaveBeenCalled();
    expect(screen.getByText('Type DELETE to confirm')).toBeTruthy();
  });

  it('★ refuses a mistyped confirmation without making a request', async () => {
    signIn({ firebase: false });
    const screen = await renderScreen();

    await fireEvent.changeText(screen.getByPlaceholderText('Your current password'), 'Password123!');
    await fireEvent.changeText(screen.getByPlaceholderText('DELETE'), 'delete');
    await fireEvent.press(screen.getByText('Delete my account'));

    expect(mockDeleteAccount).not.toHaveBeenCalled();
    expect(screen.getByText('Type DELETE exactly')).toBeTruthy();
  });

  it('sends the current password for a legacy account, clears the session and leaves', async () => {
    const signOut = signIn({ firebase: false });
    const screen = await renderScreen();

    await fireEvent.changeText(screen.getByPlaceholderText('Your current password'), 'Password123!');
    await fireEvent.changeText(screen.getByPlaceholderText('DELETE'), 'DELETE');
    await fireEvent.press(screen.getByText('Delete my account'));

    await waitFor(() => expect(mockDeleteAccount).toHaveBeenCalledTimes(1));
    expect(mockDeleteAccount).toHaveBeenCalledWith('session-token', {
      confirmation: 'DELETE',
      currentPassword: 'Password123!',
    });
    // A Firebase account's path must not be used for a password account.
    expect(mockIdToken).not.toHaveBeenCalled();
    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
    expect(mockPurgeDraft).toHaveBeenCalledWith('u1');
    expect(router.replace).toHaveBeenCalledWith('/login');
  });

  it('sends a Firebase ID token and never asks a linked account for its password', async () => {
    const signOut = signIn({ firebase: true });
    const screen = await renderScreen();

    // There is no password field at all on this path.
    expect(screen.queryByPlaceholderText('Your current password')).toBeNull();
    expect(screen.getByText(/confirm this with your sign-in/i)).toBeTruthy();

    await fireEvent.changeText(screen.getByPlaceholderText('DELETE'), 'DELETE');
    await fireEvent.press(screen.getByText('Delete my account'));

    await waitFor(() => expect(mockDeleteAccount).toHaveBeenCalledTimes(1));
    expect(mockDeleteAccount).toHaveBeenCalledWith('session-token', {
      confirmation: 'DELETE',
      idToken: 'firebase-id-token',
    });
    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
  });

  it('signs out even when the local import purge reports failure', async () => {
    const signOut = signIn({ firebase: false });
    mockPurgeDraft.mockResolvedValue(false);
    const screen = await renderScreen();

    await fireEvent.changeText(screen.getByPlaceholderText('Your current password'), 'Password123!');
    await fireEvent.changeText(screen.getByPlaceholderText('DELETE'), 'DELETE');
    await fireEvent.press(screen.getByText('Delete my account'));

    await waitFor(() => expect(mockPurgeDraft).toHaveBeenCalledWith('u1'));
    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
    expect(router.replace).toHaveBeenCalledWith('/login');
  });

  it('refuses to send anything when the provider has no identity for this device', async () => {
    const signOut = signIn({ firebase: true });
    mockIdToken.mockResolvedValue(null);
    const screen = await renderScreen();

    await fireEvent.changeText(screen.getByPlaceholderText('DELETE'), 'DELETE');
    await fireEvent.press(screen.getByText('Delete my account'));

    await waitFor(() =>
      expect(screen.getByText(/Your sign-in could not be confirmed/i)).toBeTruthy()
    );
    expect(mockDeleteAccount).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
  });

  it('★ shows the last-owner refusal and keeps the session', async () => {
    const signOut = signIn({ firebase: false });
    mockDeleteAccount.mockRejectedValue(
      new ApiError(
        409,
        'LAST_OWNER_TRANSFER_REQUIRED',
        'Other people still use this business. Make another member an owner before deleting your account.'
      )
    );
    const screen = await renderScreen();

    await fireEvent.changeText(screen.getByPlaceholderText('Your current password'), 'Password123!');
    await fireEvent.changeText(screen.getByPlaceholderText('DELETE'), 'DELETE');
    await fireEvent.press(screen.getByText('Delete my account'));

    await waitFor(() =>
      expect(screen.getByText(/Other people still use this business/i)).toBeTruthy()
    );
    expect(signOut).not.toHaveBeenCalled();
    expect(mockPurgeDraft).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('shows a field-anchored wrong-password refusal and keeps the session', async () => {
    const signOut = signIn({ firebase: false });
    mockDeleteAccount.mockRejectedValue(
      new ApiError(400, 'INVALID_CURRENT_PASSWORD', 'Your current password is incorrect.', [
        { field: 'currentPassword', message: 'Your current password is incorrect.' },
      ])
    );
    const screen = await renderScreen();

    await fireEvent.changeText(screen.getByPlaceholderText('Your current password'), 'wrong');
    await fireEvent.changeText(screen.getByPlaceholderText('DELETE'), 'DELETE');
    await fireEvent.press(screen.getByText('Delete my account'));

    await waitFor(() =>
      expect(screen.getAllByText('Your current password is incorrect.').length).toBeGreaterThan(0)
    );
    expect(signOut).not.toHaveBeenCalled();
  });

  it('shows the server sentence on a 429 and does not sign out', async () => {
    const signOut = signIn({ firebase: false });
    mockDeleteAccount.mockRejectedValue(
      new ApiError(
        429,
        'ACCOUNT_DELETION_RATE_LIMITED',
        'Too many account deletion attempts. Please wait a moment and try again.'
      )
    );
    const screen = await renderScreen();

    await fireEvent.changeText(screen.getByPlaceholderText('Your current password'), 'Password123!');
    await fireEvent.changeText(screen.getByPlaceholderText('DELETE'), 'DELETE');
    await fireEvent.press(screen.getByText('Delete my account'));

    await waitFor(() =>
      expect(screen.getByText(/Too many account deletion attempts/i)).toBeTruthy()
    );
    expect(signOut).not.toHaveBeenCalled();
  });
});
