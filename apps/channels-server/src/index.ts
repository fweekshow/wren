import "@/load-env.js";

import { initSentry } from "@/infra/sentry.js";
import { runChannelsApp } from "@/entries/channelsApp.js";

initSentry("basemate-channels");

runChannelsApp().catch((err) => {
  console.error(err);
  process.exit(1);
});
