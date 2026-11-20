import { runImessageRepl } from "@/entries/imessageRepl.js";

runImessageRepl().catch((err) => {
  console.error(err);
  process.exit(1);
});
