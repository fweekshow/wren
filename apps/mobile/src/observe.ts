export function track(event: string, props?: Record<string, string | number | boolean>): void {
  const dsn = process.env.EXPO_PUBLIC_SENTRY_DSN;
  if (!dsn) return;
  void fetch('https://sentry.io/api/0/envelope/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-sentry-envelope' },
    body: JSON.stringify({ event, props, dsn }),
  }).catch(() => undefined);
}
