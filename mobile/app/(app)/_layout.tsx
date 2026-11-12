import { Redirect, Stack } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { CenterLoader } from '../../components/ListState';
import ProfileIcon from '../../components/ProfileIcon';
import SignOutIcon from '../../components/SignOutIcon';
import { useSession } from '../../lib/auth';
import { spacing } from '../../lib/theme';
import { useTheme } from '../../lib/theme-context';

/**
 * Authenticated group layout. Renders nothing until the session is restored,
 * then redirects signed-out/deep-linked users to /login. Every child screen
 * sits in its own header stack with a native back button.
 *
 * The native header chrome is themed from `useTheme()`. This file and
 * components/SignOutIcon.jsx were frozen as owner-held through Phase 18A-18E,
 * which is why they read the static (light) `colors` alias; that freeze was
 * lifted by the owner so the header stops rendering as a white bar over a dark
 * app. Screens that declare their own `<Stack.Screen options={{ title }} />`
 * keep doing so — those set the title only and inherit these themed options.
 */
const styles = StyleSheet.create({
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
});

export default function AppLayout() {
  const { status } = useSession();
  const { colors } = useTheme();

  if (status === 'loading') {
    return <CenterLoader label="Restoring session…" />;
  }
  if (status !== 'signedIn') {
    return <Redirect href="/login" />;
  }

  return (
    <Stack
      screenOptions={{
        headerTintColor: colors.primary,
        headerTitleStyle: { fontWeight: '700', color: colors.text },
        headerStyle: { backgroundColor: colors.surface },
        headerShadowVisible: false,
        headerBackButtonDisplayMode: 'minimal',
        contentStyle: { backgroundColor: colors.background },
      }}
    >
      <Stack.Screen name="dashboard" options={{ headerShown: false }} />
      <Stack.Screen name="products/index" options={{ title: 'Products' }} />
      <Stack.Screen name="products/new" options={{ title: 'New Product' }} />
      <Stack.Screen name="products/[id]/index" options={{ title: 'Product' }} />
      <Stack.Screen name="products/[id]/edit" options={{ title: 'Edit Product' }} />
      <Stack.Screen name="scan" options={{ title: 'Scan Barcode' }} />
      <Stack.Screen name="categories" options={{ title: 'Categories' }} />
      <Stack.Screen name="locations" options={{ title: 'Locations' }} />
      <Stack.Screen name="suppliers" options={{ title: 'Suppliers' }} />
      <Stack.Screen
        name="inventory"
        options={{
          title: 'Inventory',
          // Inventory is STAFF's home screen — the Dashboard (and its Profile tile)
          // is not reachable for them — so the account link lives in this header
          // too, beside sign out.
          headerRight: () => (
            <View style={styles.headerActions}>
              <ProfileIcon />
              <SignOutIcon />
            </View>
          ),
        }}
      />
      <Stack.Screen name="inventory/[id]" options={{ title: 'Stock Record' }} />
      <Stack.Screen name="restock" options={{ title: 'Restock' }} />
      <Stack.Screen name="purchase-orders/index" options={{ title: 'Purchase Orders' }} />
      <Stack.Screen name="purchase-orders/[id]/index" options={{ title: 'Purchase Order' }} />
      <Stack.Screen name="purchase-orders/[id]/receive" options={{ title: 'Receive Stock' }} />
      <Stack.Screen name="stock-in" options={{ title: 'Stock In' }} />
      <Stack.Screen name="stock-out" options={{ title: 'Stock Out' }} />
      <Stack.Screen name="adjust" options={{ title: 'Adjust Stock' }} />
      <Stack.Screen name="transfer" options={{ title: 'Transfer Stock' }} />
      <Stack.Screen name="history" options={{ title: 'Inventory History' }} />
      <Stack.Screen name="history/[id]" options={{ title: 'Movement Details' }} />
      <Stack.Screen name="ai/index" options={{ title: 'AI Assistant' }} />
      <Stack.Screen name="ai/new" options={{ title: 'New Chat' }} />
      <Stack.Screen name="ai/[id]" options={{ title: 'AI Assistant' }} />
      <Stack.Screen name="profile" options={{ title: 'Profile' }} />
      <Stack.Screen name="sessions" options={{ title: 'Active Sessions' }} />
      <Stack.Screen name="whats-new" options={{ title: "What's New" }} />
      <Stack.Screen name="disconnect-firebase" options={{ title: 'Change sign-in password' }} />
    </Stack>
  );
}
