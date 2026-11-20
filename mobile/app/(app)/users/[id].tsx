import { useCallback, useEffect, useState } from 'react';
import { Stack, useLocalSearchParams } from 'expo-router';

import AccessDenied from '../../../components/AccessDenied';
import { CenterLoader, ErrorState, errorRequestId, errorText } from '../../../components/ListState';
import Screen from '../../../components/Screen';
import UserForm from '../../../components/UserForm';
import { usersApi } from '../../../lib/api';
import type { ApiResponse } from '../../../lib/api';
import { isSessionError, useSession } from '../../../lib/auth';
import { canManageUsers } from '../../../lib/permissions';

/**
 * Role guard (MOD-07, same shape as the Users list). The permission check lives
 * here so the loader below mounts only for a role that may manage users; with
 * the check under the hooks instead, a MANAGER or STAFF deep link issued
 * `GET /api/users/:id` and was answered 403 — the same defect F-63 fixed on the
 * list screen, still present on this one.
 */
export default function EditUserScreen() {
  const { user } = useSession();

  if (!canManageUsers(user)) {
    return (
      <>
        <Stack.Screen options={{ title: 'Edit User' }} />
        <AccessDenied message="Only the business owner and admins can manage users." />
      </>
    );
  }

  return <EditUser />;
}

function EditUser() {
  const { token, signOut } = useSession();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [target, setTarget] = useState<ApiResponse>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async (): Promise<void> => {
    if (!token || !id) return;
    setError(null);
    setLoading(true);
    try {
      const u = await usersApi.get(token, id);
      setTarget(u);
    } catch (err) {
      setError(err);
      setTarget(null);
      if (isSessionError(err)) await signOut();
    } finally {
      setLoading(false);
    }
  }, [token, id, signOut]);

  useEffect(() => {
    // `load` sets error/loading synchronously before its first await on purpose:
    // loading must be true at request start (first mount and retry), and it can't
    // be derived from `target`/`error` because a retry keeps the previous `target`
    // visible.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  return (
    <>
      <Stack.Screen options={{ title: 'Edit User' }} />
      {loading && !target ? (
        <Screen>
          <CenterLoader label="Loading user…" />
        </Screen>
      ) : error && !target ? (
        <Screen>
          <ErrorState
            title="Couldn't load this user"
            message={errorText(error)}
            requestId={errorRequestId(error)}
            onRetry={load}
          />
        </Screen>
      ) : target ? (
        <UserForm initial={target} key={target.id} />
      ) : null}
    </>
  );
}
