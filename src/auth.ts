// SecureStore mirror of the Privy session. App.tsx watches `usePrivy()` and
// calls `setSession()` whenever the Privy user (and thus the access token)
// changes; api.ts reads the mirror on each request. Keeping SecureStore as
// the source of truth lets api.ts work outside the React tree.

import * as SecureStore from 'expo-secure-store';

const USER_KEY = 'wren.user';
const TOKEN_KEY = 'wren.token';

export type Session = { user: string; token: string };

let cached: Session | null | undefined;
let loader: Promise<Session | null> | null = null;

export async function getSession(): Promise<Session | null> {
  if (cached !== undefined) return cached;
  if (loader) return loader;
  loader = (async () => {
    try {
      const [user, token] = await Promise.all([
        SecureStore.getItemAsync(USER_KEY),
        SecureStore.getItemAsync(TOKEN_KEY),
      ]);
      cached = user && token ? { user, token } : null;
    } catch {
      cached = null;
    }
    return cached;
  })();
  return loader;
}

export async function setSession(session: Session): Promise<void> {
  await Promise.all([
    SecureStore.setItemAsync(USER_KEY, session.user),
    SecureStore.setItemAsync(TOKEN_KEY, session.token),
  ]);
  cached = session;
  loader = null;
}

export async function clearSession(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(USER_KEY),
    SecureStore.deleteItemAsync(TOKEN_KEY),
  ]);
  cached = null;
  loader = null;
}

