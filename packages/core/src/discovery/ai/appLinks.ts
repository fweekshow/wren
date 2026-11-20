/**
 * Deep links into the Basemate web dashboard (/app).
 *
 * The dashboard reads the URL hash to open a specific page (see the metrics
 * app's Dashboard component), so appending `#<section>` lands the user on the
 * exact tab. Basemate shares these links in chat when a user asks about their
 * activity, sends, balance, yield, or payment settings.
 */

export type AppSection =
  | "home" // total balance lives here
  | "activity" // transaction history
  | "earn" // yield positions / rates
  | "stonks" // metrics dashboard hash; iStonks UI lives in basemate-metrics
  | "sends" // person-to-person sends
  | "settings"; // payment mode (confirm each / automatic)

/** Base URL of the dashboard. Override per-env with BASEMATE_APP_URL. */
const RAW_APP_URL = process.env.BASEMATE_APP_URL ?? "https://basemate.app/app";
export const APP_BASE_URL = RAW_APP_URL.replace(/\/$/, "");

/** Deep link to a specific dashboard page, e.g. https://basemate.app/app#activity */
export function appLink(section: AppSection): string {
  return `${APP_BASE_URL}#${section}`;
}
