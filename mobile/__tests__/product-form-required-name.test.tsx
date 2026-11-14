import { fireEvent, render, waitFor } from '@testing-library/react-native';

import ProductForm from '../components/ProductForm';
import { productsApi } from '../lib/api';
import { useSession } from '../lib/auth';
import { ThemeProvider } from '../lib/theme-context';

/**
 * The required-name path on the product form.
 *
 * The Create button sits at the bottom of a long form, so an empty submit used to
 * look inert: the request was correctly refused, but the message rendered far above
 * the viewport. The form now asks the name field to take focus, which brings the
 * message and the keyboard into view.
 *
 * This test pins the whole local behaviour: no request is sent, the name field's
 * focus handle is called, and the error is rendered. The `Input` component is
 * replaced with a small focusable stand-in so the assertion is about ProductForm
 * asking the field to focus; the real Input's focus forwarding is guarded in
 * keyboard-avoidance.test.tsx and was verified on a device.
 */

const mockNameFocus = jest.fn();

jest.mock('../components/Input', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { Text, TextInput, View } = jest.requireActual<typeof import('react-native')>('react-native');

  type MockInputProps = {
    label?: import('react').ReactNode;
    value?: string;
    onChangeText?: (text: string) => void;
    placeholder?: string;
    error?: string | null;
  };

  const MockInput = React.forwardRef<{ focus: () => void }, MockInputProps>(function MockInput(props, ref) {
    React.useImperativeHandle(ref, () => ({ focus: mockNameFocus }));

    return React.createElement(
      View,
      null,
      props.label ? React.createElement(Text, null, props.label) : null,
      React.createElement(TextInput, {
        value: props.value,
        onChangeText: props.onChangeText,
        placeholder: props.placeholder,
      }),
      props.error ? React.createElement(Text, null, props.error) : null
    );
  });

  return { __esModule: true, default: MockInput };
});

jest.mock('../lib/auth', () => ({
  useSession: jest.fn(),
}));

jest.mock('expo-router', () => ({
  router: { back: jest.fn(), push: jest.fn(), replace: jest.fn() },
}));

jest.mock('../hooks/useReferences', () => ({
  useActiveRef: () => ({ items: [], loading: false, reload: jest.fn() }),
}));

jest.mock('../lib/api', () => ({
  productsApi: { create: jest.fn(), update: jest.fn() },
  categoriesApi: { list: jest.fn() },
}));

const mockedUseSession = useSession as jest.Mock;
const create = productsApi.create as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockedUseSession.mockReturnValue({ token: 'token-1', user: { id: 'u1' }, signOut: jest.fn() });
});

describe('ProductForm — required name', () => {
  it('does not submit, focuses the name field and shows the error when the name is empty', async () => {
    const view = await render(
      <ThemeProvider>
        <ProductForm />
      </ThemeProvider>
    );

    await fireEvent.press(view.getByText('Create product'));

    await waitFor(() => expect(view.getByText('Name is required')).toBeTruthy());
    expect(create).not.toHaveBeenCalled();
    await waitFor(() => expect(mockNameFocus).toHaveBeenCalledTimes(1));
  });
});
