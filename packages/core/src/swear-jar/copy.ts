import type { StandingsRow } from "./store.js";

/** First token of display name; phones / emails → "you". */
export function jarName(raw?: string | null): string {
  const t = raw?.trim();
  if (!t) return "you";
  const first = t.split(/\s+/)[0] ?? "";
  if (!first) return "you";
  if (/^\+?\d/.test(first) || first.includes("@")) return "you";
  return first.toLowerCase();
}

export function copyArm(): string {
  return "i am alexander, iron fist of this chat. $1 a swear. the most disciplined tongue wins my insides. say count me in to get on my tab — nah if i misheard. alexander help for the rest.";
}

export function copyArmNoDelegation(connectUrl: string): string {
  return `i'm here, but i can't take tribute from you yet — reconnect, then deposit $20:\n${connectUrl}`;
}

export function copyEnvOff(): string {
  return "alexander isn't on this line yet.";
}

export function copyCatchFunded(name: string, potUsd: number): string {
  return `a fine curse, ${name}. $1 into the jar. i'm at $${potUsd}.`;
}

export function copyCatchBurst(name: string, potUsd: number): string {
  return `again, ${name}. another $1. i'm at $${potUsd}.`;
}

export function copyCatchBroke(name: string): string {
  return `a fine curse, ${name} — counted. but your purse is empty. are you broke, fine sir? deposit $20 (apple pay) so you can join the pool.`;
}

export function copyCatchNoWallet(name: string, connectUrl: string): string {
  return `a fine curse, ${name} — counted. you're not in the pool yet. are you broke, fine sir? set up your account, deposit funds, then say count me in:\n${connectUrl}`;
}

export function copyCatchOptedOut(name: string, connectUrl: string): string {
  return `a fine curse, ${name} — counted. you're not on my tab. are you broke, fine sir? set up your account, deposit funds, say count me in to join the pool:\n${connectUrl}`;
}

export function copyIouCap(name: string, owedUsd: number, connectUrl?: string): string {
  const base = `${name} owes me $${owedUsd} in unpaid tribute — still counted. are you broke, fine sir? fill the purse or say nah.`;
  if (!connectUrl) return base;
  return `${base}\n${connectUrl}`;
}

export function copyStandings(standings: StandingsRow[], potUsd: number): string {
  const eligible = standings.filter((s) => s.eligible);
  const winner = [...eligible].sort((a, b) => {
    if (a.swearCount !== b.swearCount) return a.swearCount - b.swearCount;
    return a.senderId.localeCompare(b.senderId);
  })[0];
  const sinners = [...standings]
    .filter((s) => s.swearCount > 0)
    .sort((a, b) => {
      if (a.swearCount !== b.swearCount) return b.swearCount - a.swearCount;
      return a.senderId.localeCompare(b.senderId);
    });

  const lines: string[] = [];
  if (potUsd <= 0) {
    lines.push("the jar is empty — $0.");
  } else {
    lines.push(`the jar holds $${potUsd}.`);
  }

  if (winner) {
    const wn = jarName(winner.name);
    if (winner.swearCount === 0) {
      lines.push(`${wn} leads — cleanest mouth. they'd take it.`);
    } else {
      lines.push(
        `${wn} leads with ${winner.swearCount} swear${winner.swearCount === 1 ? "" : "s"} — they'd take it.`,
      );
    }
  } else {
    lines.push("nobody's in the lead yet.");
  }

  for (const s of sinners) {
    const n = jarName(s.name);
    const count = s.swearCount;
    const unpaid = s.unpaidCount ?? 0;
    if (unpaid > 0) {
      lines.push(
        `${n}: ${count} swear${count === 1 ? "" : "s"} ($${unpaid} unpaid — not in the pool yet).`,
      );
    } else {
      lines.push(
        `${n} put $${count} in (${count} swear${count === 1 ? "" : "s"}).`,
      );
    }
  }

  return lines.join("\n");
}

export function copySettle(args: {
  potUsd: number;
  winnerName: string;
  sinnerName: string | null;
}): string {
  if (args.potUsd <= 0) return "i'm still empty. no tribute yet.";
  const sinner = args.sinnerName ? `${args.sinnerName} filled the jar` : "the jar is full";
  return `the festival is over. $${args.potUsd} usdc — ${args.winnerName} had the cleanest mouth. ${sinner}. new round — i'm empty.`;
}

export function copyEmptySettle(): string {
  return "i'm still empty. no tribute yet.";
}

export function copySettleConfirm(potUsd: number, winnerName: string): string {
  return `i hold $${potUsd}. say alexander settle to give it to ${winnerName}.`;
}

export function copyDispute(): string {
  return "a misunderstanding. i return it.";
}

export function copyNahEmpty(): string {
  return "nothing to return.";
}

export function copyOptInReady(): string {
  return "you're on my tab. $1 a swear.";
}

export function copyOptInNeedWallet(connectUrl: string): string {
  return `you're on my tab once this purse is live. set up here, then deposit $20:\n${connectUrl}`;
}

export function copyOptInNeedDelegation(connectUrl: string): string {
  return `you're on my tab after you reconnect:\n${connectUrl}`;
}

export function copyAlreadyOptedIn(): string {
  return "you're already on my tab. $1 a swear.";
}

export function copyOptOut(): string {
  return "you're off my tab. say count me in if you change your mind.";
}

export function copyDisarm(): string {
  return "i return to the jar. the chat is yours again.";
}

export function copySecrets(): string {
  return "ha! you'd pry a warrior jar for his ledger? i hold my secrets. curse foul enough and you'll know — $1. clean mouths need not ask.";
}

export function copyAlreadyArmed(): string {
  return "i'm already here. $1 a swear. say alexander help.";
}

export function copyHintSummon(): string {
  return "hey. i send cash in here. or we summon alexander — $1 a curse, cleanest mouth wins the jar. say @basemate alexander on — or alexander help once i'm here.";
}

/** What Alexander does — armed groups get the full playbook; unarmed get the summon line. */
export function copyHelp(armed: boolean): string {
  if (!armed) {
    return [
      "i am alexander. $1 usdc a swear. cleanest mouth wins the jar.",
      "summon: @basemate alexander on",
      "once i'm here: alexander help",
    ].join("\n");
  }
  return [
    "i am alexander. $1 usdc a swear and the dollar enters thy pot. cleanest mouth wins my insides.",
    "how's alexander — standings + pot",
    "what's in the pot — same",
    "alexander settle — pay the winner, new round starts",
    "nah — i misheard, refund your last $1",
    "count me in — let me charge your wallet $1 a swear",
    "off my tab — don't charge me (swears still count)",
    "alexander off — send me back to the jar (settle does not)",
    "what counts as a swear — i hold my secrets",
    "or change it in basemate.app settings",
  ].join("\n");
}
