/**
 * Alexander command matchers.
 *
 * When the jar is armed, settle/status/nah work without @basemate.
 * Bare "alexander" (a common name) never matches — need an Alexander action.
 */

export function normalizeCommand(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[\u2018\u2019\u201a\u201b`]/g, "'")
    .replace(/\s+/g, " ");
}

/** Summon — still requires @basemate at the call site. */
export function matchOn(cmd: string): boolean {
  return /\b(swear jar on|alexander on|summon alexander|iron fist|turn on the swear jar|start a swear jar|jar on)\b/.test(
    cmd,
  );
}

/** Disarm — still requires @basemate at the call site. */
export function matchOff(cmd: string): boolean {
  return /\b(swear jar off|alexander off|unsummon alexander|jar off)\b/.test(cmd);
}

/**
 * Standings / pot check. Intent only — not bare "alexander" or "jar".
 * Works ungated while armed (call site).
 */
export function matchStatus(cmd: string): boolean {
  if (
    /^(how's the jar|hows the jar|how's alexander|hows alexander|alexander\??\s*(status|standings)|jar\??\s*(status|standings))\??$/.test(
      cmd,
    )
  ) {
    return true;
  }
  if (/\b(how's the jar|hows the jar|how's alexander|hows alexander)\b/.test(cmd)) {
    return true;
  }
  // "alexander what's in the pot", "check pot", "what's in the jar"
  if (
    /\b(what'?s in the (pot|jar)|whats in the (pot|jar)|check (the )?(pot|jar)|how much (is )?(in )?(the )?(pot|jar)|jar standings|alexander standings|alexander status)\b/.test(
      cmd,
    )
  ) {
    return true;
  }
  // "sir alexander what's in the jar?"
  if (/\balexander\b/.test(cmd) && /\b(pot|jar)\b/.test(cmd) && /\b(what|how|check|status|standings|in)\b/.test(cmd)) {
    return true;
  }
  return false;
}

/**
 * Settle / empty the pot. Needs settle/empty/release + jar|pot|alexander —
 * not a lone "settle" (argument) or lone "alexander" (the person).
 */
export function matchSettle(cmd: string): boolean {
  return /\b(swear jar settle|alexander settle|settle alexander|settle (the )?(jar|pot)|empty (the )?(jar|pot)|alexander empty|release (the )?(jar|pot)|alexander release)\b/.test(
    cmd,
  );
}

export function matchNah(cmd: string): boolean {
  return /^(nah|wasn't a swear|wasnt a swear|not a swear)\b/.test(cmd);
}

/** What counts as a swear — Alexander refuses to list the ledger. */
export function matchSecrets(cmd: string): boolean {
  if (
    /\b(what counts as a swear|what('?s| is) a swear|which words? (count|are swears)|list (the )?swears|what do you (count|fine)|how do you (decide|judge)|what makes a swear)\b/.test(
      cmd,
    )
  ) {
    return true;
  }
  if (/\balexander\b/.test(cmd) && /\b(swear|curse|foul)\b/.test(cmd) && /\b(what|which|how|count|list)\b/.test(cmd)) {
    return true;
  }
  return false;
}

/**
 * Help / how-to. Needs alexander|jar + help/commands/how — not bare "help".
 */
/** Personal tab — not group summon. */
export function matchOptIn(cmd: string): boolean {
  return /\b(count me in|opt[\s-]?in|put me on( the (jar|tab))?|add me to the (jar|tab)|on my tab|charge me|take my (money|tribute)|i want (on|in))\b/.test(
    cmd,
  );
}

/** Personal tab off — not group disarm. */
export function matchOptOut(cmd: string): boolean {
  return /\b(opt[\s-]?out|off my tab|don'?t charge me|leave me out|not on my tab|remove me from the (jar|tab)|i'?m out of the jar)\b/.test(
    cmd,
  );
}

export function matchHelp(cmd: string): boolean {
  if (
    /^(alexander help|help alexander|swear jar help|jar help|alexander\??\s*commands)\??$/.test(cmd)
  ) {
    return true;
  }
  return /\b(alexander help|help alexander|swear jar help|jar help|alexander commands|what can alexander do|how does alexander work|how do i (use|work) alexander)\b/.test(
    cmd,
  );
}
