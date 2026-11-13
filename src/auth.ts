// Session state. Reads `user` and `token` out of the wren://connected fragment
// on return from the sign-in page and stores them in SecureStore.

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

// Parse the fragment from a wren://connected#user=...&token=... deep link.
// Accepts either fragment or query form, since the sender might mix them up.
export function parseConnectedUrl(url: string): Session | null {
  if (!url) return null;
  // Pull everything after the first `#` or `?`, whichever comes first.
  const hash = url.indexOf('#');
  const query = url.indexOf('?');
  let paramStr = '';
  if (hash >= 0) paramStr = url.slice(hash + 1);
  else if (query >= 0) paramStr = url.slice(query + 1);
  if (!paramStr) return null;
  const params = new URLSearchParams(paramStr);
  const user = params.get('user');
  const token = params.get('token');
  if (!user || !token) return null;
  return { user, token };
}
