import { fireEvent, render, waitFor } from '@testing-library/react-native';

import ProductForm from '../components/ProductForm';
import { productsApi } from '../lib/api';
import { useSession } from '../lib/auth';
import { ApiError } from '../lib/client';
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
const mockSecureStore = new Map<string, string>();
const mockUseActiveRef = jest.fn();

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async (key: string) => mockSecureStore.get(key) ?? null),
  setItemAsync: jest.fn(async (key: string, value: string) => {
    mockSecureStore.set(key, value);
  }),
  deleteItemAsync: jest.fn(async (key: string) => {
    mockSecureStore.delete(key);
  }),
}));

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
        testID: typeof props.label === 'string' ? `input-${props.label}` : undefined,
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
  ...jest.requireActual('../hooks/useReferences'),
  useActiveRef: (...args: unknown[]) => mockUseActiveRef(...args),
}));

jest.mock('../lib/api', () => ({
  productsApi: { create: jest.fn(), update: jest.fn(), correctCurrency: jest.fn() },
  categoriesApi: { list: jest.fn() },
}));

const mockedUseSession = useSession as jest.Mock;
const create = productsApi.create as jest.Mock;
const update = productsApi.update as jest.Mock;
const correctCurrency = productsApi.correctCurrency as jest.Mock;

async function selectCurrency(
  view: Awaited<ReturnType<typeof render>>,
  query: string,
  label: string,
) {
  await fireEvent.press(view.getByTestId('currency-picker'));
  await fireEvent.changeText(view.getByPlaceholderText('Search…'), query);
  await waitFor(() => expect(view.getByText(label)).toBeTruthy());
  await fireEvent.press(view.getByText(label));
  await waitFor(() => expect(view.getByText(label)).toBeTruthy());
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSecureStore.clear();
  mockedUseSession.mockReturnValue({ token: 'token-1', user: { id: 'u1' }, signOut: jest.fn() });
  mockUseActiveRef.mockReturnValue({ items: [], loading: false, complete: true, reload: jest.fn() });
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

describe('ProductForm — create idempotency', () => {
  it('★ keeps the create key after a 5xx, because the product may already exist', async () => {
    create
      .mockRejectedValueOnce(new ApiError(500, 'SERVER_ERROR', 'The product could not be saved.'))
      .mockResolvedValueOnce({ id: 'product-1', name: 'Kettle' });

    const view = await render(
      <ThemeProvider>
        <ProductForm />
      </ThemeProvider>
    );

    await fireEvent.changeText(view.getByTestId('input-Product name'), 'Kettle');
    await selectCurrency(view, 'PHP', 'PHP — Philippine Peso');
    await fireEvent.press(view.getByText('Create product'));
    await waitFor(() => expect(view.getByText('The product could not be saved.')).toBeTruthy());

    await fireEvent.press(view.getByText('Create product'));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));

    expect(create.mock.calls[1][2]).toBe(create.mock.calls[0][2]);
  });

  it('★ requires a currency before sending anything', async () => {
    const view = await render(
      <ThemeProvider>
        <ProductForm />
      </ThemeProvider>
    );

    await fireEvent.changeText(view.getByTestId('input-Product name'), 'Kettle');
    await fireEvent.press(view.getByText('Create product'));

    await waitFor(() =>
      expect(view.getByText('Currency is required. Use a valid ISO 4217 code, e.g. PHP')).toBeTruthy()
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('★ searches the ISO list by currency name and saves the selected code', async () => {
    const view = await render(
      <ThemeProvider>
        <ProductForm />
      </ThemeProvider>
    );

    await fireEvent.changeText(view.getByTestId('input-Product name'), 'Kettle');
    await fireEvent.press(view.getByTestId('currency-picker'));
    await fireEvent.changeText(view.getByPlaceholderText('Search…'), 'philippine');

    await waitFor(() => expect(view.getByText('PHP — Philippine Peso')).toBeTruthy());
    expect(view.queryByText('USD — US Dollar')).toBeNull();

    await fireEvent.press(view.getByText('PHP — Philippine Peso'));
    await fireEvent.press(view.getByText('Create product'));

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0][1]).toMatchObject({ currency: 'PHP' });
  });

  it('★ shows a legacy product without currency as unselected and requires a choice', async () => {
    const view = await render(
      <ThemeProvider>
        <ProductForm initial={{ id: 'legacy-1', name: 'Kettle', currency: null }} />
      </ThemeProvider>
    );

    expect(view.getByText('Select a currency…')).toBeTruthy();
    await fireEvent.press(view.getByText('Save changes'));
    await waitFor(() => expect(view.getByText('Currency is required. Use a valid ISO 4217 code, e.g. PHP')).toBeTruthy());
    expect(update).not.toHaveBeenCalled();
    expect(correctCurrency).not.toHaveBeenCalled();

    await selectCurrency(view, 'USD', 'USD — US Dollar');
    await fireEvent.press(view.getByText('Save changes'));

    await waitFor(() => expect(view.getByText('Explain why the recorded currency is changing (at least 3 characters).')).toBeTruthy());
    expect(correctCurrency).not.toHaveBeenCalled();

    await fireEvent.changeText(
      view.getByTestId('input-Currency correction reason'),
      'Supplier invoice shows USD',
    );
    await fireEvent.press(view.getByText('I reconfirmed cost and selling prices'));
    await fireEvent.press(view.getByText('Save changes'));

    await waitFor(() => expect(correctCurrency).toHaveBeenCalledTimes(1));
    expect(correctCurrency.mock.calls[0][2]).toMatchObject({
      currency: 'USD',
      reason: 'Supplier invoice shows USD',
      priceReconfirmed: true,
    });
    expect(correctCurrency.mock.calls[0][2].currencyCorrection).toBeUndefined();
    expect(update).not.toHaveBeenCalled();
  });

  it('★ treats a non-canonical legacy code as needing an explicit correction', async () => {
    const view = await render(
      <ThemeProvider>
        <ProductForm initial={{ id: 'legacy-2', name: 'Kettle', currency: 'php' }} />
      </ThemeProvider>
    );

    expect(view.getByText('Currency correction reason')).toBeTruthy();
    await fireEvent.press(view.getByText('Save changes'));
    await waitFor(() =>
      expect(view.getByText('Explain why the recorded currency is changing (at least 3 characters).')).toBeTruthy()
    );
    expect(update).not.toHaveBeenCalled();
    expect(correctCurrency).not.toHaveBeenCalled();
  });
});

describe('ProductForm — archived category lifecycle', () => {
  it('★ does not silently submit an archived category and offers a safe repair', async () => {
    mockUseActiveRef.mockReturnValue({
      items: [{ id: 'cat-active', name: 'Active category' }],
      loading: false,
      complete: true,
      reload: jest.fn(),
    });
    update.mockResolvedValue({ id: 'p1' });

    const view = await render(
      <ThemeProvider>
        <ProductForm
          initial={{
            id: 'p1',
            name: 'Kettle',
            currency: 'PHP',
            category: { id: 'cat-archived', name: 'Retired category' },
          }}
        />
      </ThemeProvider>
    );

    expect(
      view.getByText(
        'This category is archived or unavailable. Choose an active category, or remove it before saving.'
      )
    ).toBeTruthy();

    await fireEvent.press(view.getByText('Save changes'));
    await waitFor(() =>
      expect(view.getByText('Choose an active category, or remove the archived one.')).toBeTruthy()
    );
    expect(update).not.toHaveBeenCalled();

    await fireEvent.press(view.getByText('Remove archived category'));
    await fireEvent.press(view.getByText('Save changes'));

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0][2]).toMatchObject({ categoryId: null });
  });
});
