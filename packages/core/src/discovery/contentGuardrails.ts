export type ContentGuardrailCategory =
  | "politics"
  | "religion"
  | "programming"
  | "off_topic"
  | "verbose_off_topic";

export interface ContentGuardrailResult {
  category: ContentGuardrailCategory;
  reply: string;
}

const DEFAULT_REFUSAL =
  "ah i'm really just here for base + crypto stuff — swaps, earn, perps, and good onchain vibes. what are we getting into? 💙";

const REFUSALS: Record<ContentGuardrailCategory, string> = {
  politics:
    "ah i stay out of politics — i'm here for base, crypto, swaps, earn, and perps. what are we doing onchain? 💙",
  religion:
    "ah i stay out of religion chats — i'm here for base, crypto, swaps, earn, and perps. what are we doing onchain? 💙",
  programming:
    "ah i can't write code here — i'm focused on base + crypto actions like swaps, earn, perps, and token info. what do you want to do onchain? 💙",
  off_topic: DEFAULT_REFUSAL,
  verbose_off_topic:
    "ah let's keep it tight — i'm here for base + crypto, not long off-topic deep dives. what are we doing onchain? 💙",
};

const CRYPTO_CONTEXT_RE =
  /\b(base|base app|basemate|bankr|crypto|onchain|defi|dex|dexscreener|swap|send|token|coin|memecoin|contract address|ca\b|wallet|address|0x[a-f0-9]{6,}|eth|usdc|btc|cbbtc|perp|perps|avantis|morpho|moonwell|aave|uniswap|aerodrome|yield|earn|lend|supply|portfolio|pnl|copy trading|governance token|dao)\b/i;

const CASUAL_RELIGION_RE = /\b(omg|oh my god|jesus christ|god damn|goddamn)\b/i;

export function contentGuardrailsDisabled(): boolean {
  return process.env.CONTENT_GUARDRAILS_DISABLED === "true" || process.env.CONTENT_GUARDRAILS_DISABLED === "1";
}

export function pickGuardrailRefusal(category: ContentGuardrailCategory): string {
  return REFUSALS[category] ?? DEFAULT_REFUSAL;
}

export function checkInboundContentGuardrails(message: string): ContentGuardrailResult | null {
  if (contentGuardrailsDisabled()) return null;

  const normalized = message.trim().replace(/\s+/g, " ");
  if (!normalized) return null;

  const category = classifyGuardrailCategory(normalized);
  if (!category) return null;

  return {
    category,
    reply: pickGuardrailRefusal(category),
  };
}

export function sanitizeOutboundContent(text: string): string {
  if (contentGuardrailsDisabled()) return text;
  if (containsCodeOutput(text)) return pickGuardrailRefusal("programming");
  return text;
}

function classifyGuardrailCategory(message: string): ContentGuardrailCategory | null {
  if (isProgrammingRequest(message)) return "programming";
  if (isPoliticalRequest(message)) return "politics";
  if (isReligionRequest(message)) return "religion";
  if (isVerboseOffTopicRequest(message)) return "verbose_off_topic";
  if (isOffTopicRequest(message)) return "off_topic";
  return null;
}

function hasCryptoContext(message: string): boolean {
  return CRYPTO_CONTEXT_RE.test(message);
}

function isProgrammingRequest(message: string): boolean {
  const m = message.toLowerCase();

  if (/```|^\s*(?:import|export|function|class|const|let|var)\s+\w+/im.test(message)) return true;
  if (/\b(?:write|generate|create|build|code|implement|debug|fix|refactor)\b.*\b(?:code|script|program|function|app|bot|api|component|contract|solidity|python|javascript|typescript|react|next\.?js|node\.?js|rust|go|java|sql)\b/i.test(m))
    return true;
  if (/\b(?:python|javascript|typescript|solidity|react|next\.?js|node\.?js|rust|go|java|sql)\b.*\b(?:code|script|function|debug|fix|implement|write|build)\b/i.test(m))
    return true;
  if (/\b(?:npm install|pnpm|yarn add|pip install|pragma solidity|console\.log|def\s+\w+\(|function\s+\w+\(|class\s+\w+)\b/i.test(message))
    return true;

  return false;
}

function isPoliticalRequest(message: string): boolean {
  if (hasCryptoContext(message)) return false;

  return (
    /\b(?:election|vote|voting|ballot|campaign|senate|congress|parliament|president|prime minister|political party|democrat|republican|liberal|conservative)\b/i.test(
      message,
    ) ||
    /\b(?:biden|trump|obama|clinton|putin|zelensky|netanyahu|modi|xi jinping)\b/i.test(message) ||
    /\b(?:who should i vote for|which party should|politics|political)\b/i.test(message)
  );
}

function isReligionRequest(message: string): boolean {
  if (hasCryptoContext(message)) return false;
  if (CASUAL_RELIGION_RE.test(message) && message.split(/\s+/).length <= 8) return false;

  return (
    /\b(?:religion|religious|christianity|christian|islam|muslim|judaism|jewish|hinduism|hindu|buddhism|buddhist|atheism|atheist|scripture|bible|quran|torah|church|mosque|temple|prayer)\b/i.test(
      message,
    ) ||
    /\b(?:is god real|does god exist|which religion|convert to)\b/i.test(message)
  );
}

function isVerboseOffTopicRequest(message: string): boolean {
  if (hasCryptoContext(message)) return false;

  return /\b(?:write|give me|make|create|explain)\b.*\b(?:essay|long[- ]form|deep dive|extreme detail|2000 words|3000 words|50 reasons|100 reasons)\b/i.test(
    message,
  );
}

function isOffTopicRequest(message: string): boolean {
  if (hasCryptoContext(message)) return false;

  return (
    /\b(?:abortion|gun control|climate change|culture war|race debate|gender debate|immigration debate|vaccine mandate|israel.?palestine|russia.?ukraine)\b/i.test(
      message,
    ) ||
    /\b(?:homework|school assignment|cover letter|resume|dating profile|poem|song lyrics|screenplay|story prompt)\b/i.test(
      message,
    ) ||
    /\b(?:medical advice|legal advice|diagnose me|treatment plan|lawsuit|tax advice)\b/i.test(message)
  );
}

function containsCodeOutput(text: string): boolean {
  if (/```/.test(text)) return true;
  if (/^\s{2,}(?:import|export|function|class|const|let|var|def|pragma)\s+\w+/im.test(text)) return true;
  if (/\b(?:function\s+\w+\(|class\s+\w+|def\s+\w+\(|pragma solidity|console\.log|npm install|pip install)\b/i.test(text))
    return true;
  return false;
}
