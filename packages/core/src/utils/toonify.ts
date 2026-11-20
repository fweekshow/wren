import { encode } from "@toon-format/toon";

import { logger } from "@/utils/logger.js";

export const toonify =
  <TArgs extends unknown[], TResult>(fn: (...args: TArgs) => TResult) =>
  async (...args: TArgs) => {
    const functionName = fn.name || "anonymous";

    logger.info({ function: functionName }, "🔧 [toonify] Function called");

    const result = await fn(...args);
    const toonResult = encode(result);

    logger.info({ response: toonResult }, "📤 [toonify] Output response");

    return toonResult;
  };
