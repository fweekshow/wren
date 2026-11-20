import { and, eq, gte, isNotNull, lte, or, sql } from "drizzle-orm";

import { drizzleDb } from "@/db/client.js";
import { investorContacts, type InvestorContact, type NewInvestorContact } from "@/db/schema/investor-funnel.js";
import { logger } from "@/utils/logger.js";
import { type EventResult, type PluginMetadata, XMTPServicePlugin } from "@/xmtp/core/index.js";
import { sendAgentText } from "@/xmtp/core/utils.js";
import type { MessageContext } from "@xmtp/agent-sdk";

// ---------------------------------------------------------------------------
// Stage definitions
// ---------------------------------------------------------------------------

type Stage =
  | "identified"
  | "researching"
  | "outreach_sent"
  | "meeting_scheduled"
  | "meeting_done"
  | "follow_up"
  | "term_sheet"
  | "passed"
  | "on_hold";

const STAGE_EMOJI: Record<Stage, string> = {
  identified: "🔍",
  researching: "📊",
  outreach_sent: "📨",
  meeting_scheduled: "📅",
  meeting_done: "✅",
  follow_up: "🔄",
  term_sheet: "💰",
  passed: "❌",
  on_hold: "⏸",
};

const STAGE_ALIASES: Record<string, Stage> = {
  id: "identified",
  identify: "identified",
  identified: "identified",
  research: "researching",
  researching: "researching",
  outreach: "outreach_sent",
  "outreach_sent": "outreach_sent",
  sent: "outreach_sent",
  scheduled: "meeting_scheduled",
  "meeting_scheduled": "meeting_scheduled",
  meeting: "meeting_scheduled",
  met: "meeting_done",
  done: "meeting_done",
  "meeting_done": "meeting_done",
  follow: "follow_up",
  followup: "follow_up",
  "follow_up": "follow_up",
  ts: "term_sheet",
  "term_sheet": "term_sheet",
  termsheet: "term_sheet",
  pass: "passed",
  passed: "passed",
  no: "passed",
  hold: "on_hold",
  "on_hold": "on_hold",
  pause: "on_hold",
};

function parseStage(input: string): Stage | null {
  return STAGE_ALIASES[input.toLowerCase().replace(/[\s-]/g, "_")] ?? null;
}

// ---------------------------------------------------------------------------
// Pre-seeded Singapore VC list (curated Aug 2026)
// ---------------------------------------------------------------------------

const SG_VCS: Omit<NewInvestorContact, "seeded">[] = [
  // ─── Tier 1: highest-fit for Basemate (messaging × DeFi × AI trading) ───
  {
    name: "Melody He / Jason Choi",
    firm: "Spartan Group",
    website: "https://thespartangroup.io",
    twitter: "@spartangroup_",
    focus: "DeFi, Consumer Crypto, Fintech",
    checkSize: "$500k–$10M",
    stages: "Seed, Series A",
    location: "Singapore",
    tier: "tier1",
    notes: "One of the most active SG DeFi VCs. Jason Choi is very public on CT. DM-first approach works well — they respond to cold XMTP/TG.",
  },
  {
    name: "Shina Lim / Ash Patel",
    firm: "Signum Capital",
    website: "https://signum.capital",
    linkedin: "https://linkedin.com/company/signum-capital",
    focus: "DeFi, Financial Infrastructure, Stablecoins",
    checkSize: "$1.6M–$31M",
    stages: "Seed, Series A",
    location: "Singapore",
    tier: "tier1",
    notes: "DeFi-native fund. Shina focuses on fintech infra and stablecoins. Ash covers DeFi/gaming. Very thesis-aligned with Basemate's chat-native trading.",
  },
  {
    name: "Kang Ming Tee",
    firm: "LuneX Ventures",
    website: "https://lunex.vc",
    twitter: "@lunexvc",
    focus: "Blockchain, Cryptocurrency, Consumer",
    checkSize: "$410k–$5.8M",
    stages: "Pre-Seed, Seed",
    location: "Singapore",
    tier: "tier1",
    notes: "Spun out of Golden Gate Ventures. First dedicated crypto fund in SG. Small checks, fast decisions. Good for seed bridge.",
  },
  {
    name: "Thinking / Research team",
    firm: "SevenX Ventures",
    website: "https://7xvc.com",
    twitter: "@SevenXVentures",
    focus: "DeFi, Web3 Infrastructure, Decentralized AI",
    checkSize: "$500k–$5M",
    stages: "Seed, Series A",
    location: "Singapore",
    tier: "tier1",
    notes: "Research-driven, founded 2020. Active in decentralized AI — exactly where Basemate's AI trading agent thesis fits. Worth a research-led cold reach.",
  },
  {
    name: "Andrei Grachev",
    firm: "DWF Labs",
    website: "https://dwf-labs.com",
    telegram: "@DWFLabs",
    focus: "DeFi, AI × Crypto, RWA, DePIN",
    checkSize: "$1M–$50M",
    stages: "Seed, Series A, Growth",
    location: "Singapore",
    tier: "tier1",
    notes: "$1B+ deployed, 470+ portfolio co's. Combine VC + market-making — great for Basemate token liquidity if/when needed. Very responsive to direct DMs.",
  },
  {
    name: "Ben Zhou team",
    firm: "Mirana Ventures",
    website: "https://mirana.xyz",
    twitter: "@MiranaVentures",
    focus: "DeFi, CeFi, Infrastructure, Consumer",
    checkSize: "$500k–$20M",
    stages: "Seed, Series A",
    location: "Singapore",
    tier: "tier1",
    notes: "ByBit's strategic VC arm. Distribution angle: portfolio companies get ByBit listing / user access. Strong SG network. Equity + token deals.",
  },
  {
    name: "David Nage / team",
    firm: "Ethereal Ventures",
    website: "https://ethereal.ventures",
    twitter: "@EtherealVC",
    focus: "DeFi, Consumer, AI Agents",
    checkSize: "$500k–$3M",
    stages: "Pre-Seed, Seed",
    location: "United States (SG deals)",
    tier: "tier1",
    notes: "Led Fere AI's $1.3M round (Apr 2026) — direct Basemate comparable. They KNOW the autonomous trading agent thesis. Use Fere as a comp in your pitch.",
  },
  {
    name: "Imran Khan / Tom Schmidt",
    firm: "Big Brain Holdings",
    website: "https://bigbrain.holdings",
    twitter: "@BigBrainVC",
    focus: "Consumer Crypto, DeFi, NFT, Gaming",
    checkSize: "$200k–$3M",
    stages: "Pre-Seed, Seed",
    location: "Singapore, US",
    tier: "tier1",
    notes: "Very active on X/CT. Community-first mindset maps well to Basemate's chat-native product. Fast movers for seed checks.",
  },

  // ─── Tier 2: strong fits, longer cycle ───────────────────────────────────
  {
    name: "Vivien Chan / team",
    firm: "HashKey Capital",
    website: "https://capital.hashkey.com",
    linkedin: "https://linkedin.com/company/hashkey-capital",
    focus: "Institutional DeFi, RWA, Infrastructure",
    checkSize: "$500k–$25M",
    stages: "Seed, Series A",
    location: "Singapore, Hong Kong",
    tier: "tier2",
    notes: "Licensed rails, institutional distribution. Better fit once Basemate has >$1M ARR or strong institutional traction. Long due diligence cycle.",
  },
  {
    name: "Omer Ozden",
    firm: "Blockchain Founders Fund",
    website: "https://bff.fund",
    twitter: "@BFFund",
    focus: "Blockchain, Web3 Infra, DeFi",
    checkSize: "$200k–$2M",
    stages: "Pre-Seed, Seed",
    location: "Singapore",
    tier: "tier2",
    notes: "SG-based early-stage crypto fund. Good SG network and intros. Smaller checks but useful for strategic value-add.",
  },
  {
    name: "Jehan Chu",
    firm: "Kenetic Capital",
    website: "https://kenetic.capital",
    twitter: "@KeneticCapital",
    focus: "Blockchain, Cryptocurrency, Fintech",
    checkSize: "$1.4M–$30M",
    stages: "Seed, Series A",
    location: "Singapore, Hong Kong, US",
    tier: "tier2",
    notes: "18 SG investments on record. Founder Jehan is active on Twitter. Fintech and DeFi thesis works for Basemate.",
  },
  {
    name: "Simon Seojoon Kim",
    firm: "Hashed",
    website: "https://hashed.com",
    twitter: "@hashed_official",
    focus: "DeFi, Gaming, Web3 Consumer",
    checkSize: "$500k–$10M",
    stages: "Seed, Series A",
    location: "Korea, Singapore",
    tier: "tier2",
    notes: "Top-tier Asian crypto fund. SG office is growing. Consumer crypto focus maps well. Best approached via warm intro through SG network.",
  },
  {
    name: "Forest Bai",
    firm: "Foresight Ventures",
    website: "https://foresightventures.com",
    twitter: "@ForesightVen",
    focus: "DeFi, Web3, Layer 1/2 Infra",
    checkSize: "$500k–$10M",
    stages: "Seed, Series A",
    location: "Singapore",
    tier: "tier2",
    notes: "BitGet-affiliated fund. Active in SG ecosystem. Infrastructure-heavy thesis but open to consumer. Bitmain/mining background.",
  },
  {
    name: "Kosmos team",
    firm: "Kosmos Ventures",
    website: "https://kosmosventures.com",
    twitter: "@KosmosVC",
    focus: "Consumer Crypto, DeFi, Blockchain Infrastructure",
    checkSize: "$500k–$5M",
    stages: "Seed, Series A",
    location: "Australia, Singapore",
    tier: "tier2",
    notes: "Also backed Fere AI. Focus on 'rebellious founders building consumer apps that enable emergent behaviour'. Very aligned with Basemate's messaging-first angle.",
  },
];

// ---------------------------------------------------------------------------
// Date parsing helpers
// ---------------------------------------------------------------------------

const DAYS_OF_WEEK = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const DAY_SHORT = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function parseMeetingDate(input: string): Date | null {
  const lower = input.toLowerCase().trim();
  const now = new Date();
  const today = now.getDay(); // 0 = Sunday

  // "today", "tomorrow"
  if (lower === "today") return now;
  if (lower === "tomorrow") {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    return d;
  }

  // Day of week — "friday", "fri", "this friday", "next friday"
  for (let i = 0; i < DAYS_OF_WEEK.length; i++) {
    if (lower.includes(DAYS_OF_WEEK[i]) || lower.includes(DAY_SHORT[i])) {
      const diff = (i - today + 7) % 7 || 7;
      const d = new Date(now);
      d.setDate(d.getDate() + diff);
      return d;
    }
  }

  // "Aug 7", "August 8", "8 Aug", "08/08"
  const formats = [
    /(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?/,
    /(\w+ \d{1,2}|\d{1,2} \w+)/,
  ];
  for (const re of formats) {
    const m = lower.match(re);
    if (m) {
      const parsed = new Date(`${m[0]} 2026`);
      if (!isNaN(parsed.getTime())) return parsed;
    }
  }

  return null;
}

function fmtDate(d: Date | null): string {
  if (!d) return "TBD";
  return d.toLocaleDateString("en-SG", { weekday: "short", month: "short", day: "numeric" });
}

// ---------------------------------------------------------------------------
// Fuzzy name/firm matcher
// ---------------------------------------------------------------------------

function matchVC(list: InvestorContact[], query: string): InvestorContact | null {
  const q = query.toLowerCase();
  // Exact firm match first
  const exact = list.find(
    (v) => v.firm.toLowerCase() === q || v.name.toLowerCase() === q,
  );
  if (exact) return exact;
  // Partial firm or name
  return (
    list.find(
      (v) =>
        v.firm.toLowerCase().includes(q) ||
        v.name.toLowerCase().includes(q) ||
        q.includes(v.firm.toLowerCase().split(" ")[0]),
    ) ?? null
  );
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const INVESTOR_RE =
  /\b(?:investor|investors|vc|vcs|pipeline|funnel|raise|fundrais)/i;
const THIS_WEEK_RE = /\b(?:this week|week|upcoming|meetings?)/i;

export class InvestorFunnelPlugin extends XMTPServicePlugin {
  metadata: PluginMetadata = {
    name: "InvestorFunnelPlugin",
    version: "1.0.0",
    priority: 25,
    description: "Singapore VC investor funnel — track outreach, meetings, and pipeline",
  };

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async onInit(): Promise<void> {
    await this.seedIfNeeded();
    logger.info("✅ InvestorFunnelPlugin initialized");
  }

  private async seedIfNeeded(): Promise<void> {
    try {
      const existing = await drizzleDb
        .select({ id: investorContacts.id })
        .from(investorContacts)
        .where(eq(investorContacts.seeded, 1))
        .limit(1);

      if (existing.length > 0) return; // already seeded

      await drizzleDb.insert(investorContacts).values(
        SG_VCS.map((v) => ({ ...v, seeded: 1 })),
      );
      logger.info(`💾 InvestorFunnelPlugin: seeded ${SG_VCS.length} Singapore VCs`);
    } catch (err: any) {
      logger.warn(`⚠️ InvestorFunnelPlugin seed failed: ${err?.message ?? err}`);
    }
  }

  // ── Commands ──────────────────────────────────────────────────────────────

  getCommands() {
    const commands = new Map<string, (ctx: MessageContext<string>) => Promise<void>>();

    // /investors  — full pipeline dashboard
    commands.set("/investors", async (ctx) => {
      await this.showPipeline(ctx);
    });

    // /vc  — routes sub-commands
    commands.set("/vc", async (ctx) => {
      const raw = (ctx.message.content as string).replace(/^\/vc\s*/i, "").trim();
      await this.routeVcCommand(ctx, raw);
    });

    return commands;
  }

  // ── Natural language passthrough ──────────────────────────────────────────

  async onText(ctx: MessageContext<string>): Promise<EventResult> {
    const text = ctx.message.content.toLowerCase();

    if (INVESTOR_RE.test(text)) {
      if (THIS_WEEK_RE.test(text)) {
        await this.showThisWeek(ctx);
        return true;
      }
      if (/\bpipeline\b|\bfunnel\b/.test(text)) {
        await this.showPipeline(ctx);
        return true;
      }
      if (/\blist\b|\bshow\b|\ball\b/.test(text)) {
        await this.showPipeline(ctx);
        return true;
      }
    }

    return false;
  }

  // ── Sub-command router ────────────────────────────────────────────────────

  private async routeVcCommand(ctx: MessageContext<string>, args: string): Promise<void> {
    if (!args || args === "list") {
      await this.showPipeline(ctx);
      return;
    }

    const lower = args.toLowerCase();

    if (lower === "this-week" || lower === "thisweek" || lower === "week") {
      await this.showThisWeek(ctx);
      return;
    }

    if (lower === "pipeline" || lower === "funnel") {
      await this.showPipeline(ctx);
      return;
    }

    // /vc add <name> @ <firm> [tier1|tier2]
    const addMatch = args.match(/^add\s+(.+?)\s+@\s+(.+?)(?:\s+(tier[123]))?$/i);
    if (addMatch) {
      await this.addVC(ctx, addMatch[1].trim(), addMatch[2].trim(), addMatch[3] as any);
      return;
    }

    // /vc stage <name> <stage>
    const stageMatch = args.match(/^stage\s+(.+?)\s+(\S+)$/i);
    if (stageMatch) {
      await this.updateStage(ctx, stageMatch[1].trim(), stageMatch[2].trim());
      return;
    }

    // /vc note <name> <text>
    const noteMatch = args.match(/^note\s+(.+?)\s+(.+)$/i);
    if (noteMatch) {
      await this.addNote(ctx, noteMatch[1].trim(), noteMatch[2].trim());
      return;
    }

    // /vc meet <name> <date>
    const meetMatch = args.match(/^meet(?:ing)?\s+(.+?)\s+(?:on\s+)?(.+)$/i);
    if (meetMatch) {
      await this.scheduleMeeting(ctx, meetMatch[1].trim(), meetMatch[2].trim());
      return;
    }

    // /vc <name>  — show detail
    await this.showDetail(ctx, args);
  }

  // ── Views ─────────────────────────────────────────────────────────────────

  private async showPipeline(ctx: MessageContext<string>): Promise<void> {
    try {
      const all = await drizzleDb
        .select()
        .from(investorContacts)
        .orderBy(investorContacts.tier, investorContacts.firm);

      if (all.length === 0) {
        await sendAgentText(ctx, "No investors in funnel yet. Use /vc add <name> @ <firm> to add one.");
        return;
      }

      const byStage = new Map<Stage, InvestorContact[]>();
      for (const v of all) {
        const s = (v.stage ?? "identified") as Stage;
        if (!byStage.has(s)) byStage.set(s, []);
        byStage.get(s)!.push(v);
      }

      const stageOrder: Stage[] = [
        "identified",
        "researching",
        "outreach_sent",
        "meeting_scheduled",
        "meeting_done",
        "follow_up",
        "term_sheet",
        "passed",
        "on_hold",
      ];

      const lines: string[] = [
        `📊 Investor Pipeline — ${all.length} VCs`,
        "",
      ];

      for (const stage of stageOrder) {
        const group = byStage.get(stage);
        if (!group || group.length === 0) continue;

        const emoji = STAGE_EMOJI[stage];
        const label = stage.replace(/_/g, " ");
        const names = group.map((v) => v.firm).join(", ");
        lines.push(`${emoji} ${label} (${group.length}): ${names}`);
      }

      // This week's meetings
      const weekMeetings = await this.getThisWeekMeetings();
      if (weekMeetings.length > 0) {
        lines.push("", "📅 This week:");
        for (const v of weekMeetings) {
          lines.push(`  • ${v.firm}${v.name ? ` (${v.name})` : ""} — ${fmtDate(v.meetingDate)}`);
        }
      }

      lines.push("", "Commands: /vc <firm> · /vc stage <firm> <stage> · /vc meet <firm> <day> · /vc note <firm> <text>");

      await sendAgentText(ctx, lines.join("\n"));
    } catch (err: any) {
      logger.error(`❌ InvestorFunnelPlugin.showPipeline: ${err?.message ?? err}`);
      await sendAgentText(ctx, "Error loading pipeline. Try again.");
    }
  }

  private async showThisWeek(ctx: MessageContext<string>): Promise<void> {
    try {
      const meetings = await this.getThisWeekMeetings();

      if (meetings.length === 0) {
        await sendAgentText(
          ctx,
          "No meetings scheduled this week.\n\nSchedule one: /vc meet <firm> <day>\nExample: /vc meet spartan thursday",
        );
        return;
      }

      const lines = ["📅 Meetings this week:", ""];
      for (const v of meetings) {
        const emoji = STAGE_EMOJI[(v.stage as Stage) ?? "meeting_scheduled"];
        lines.push(`${emoji} ${v.firm}`);
        if (v.name) lines.push(`   Contact: ${v.name}`);
        lines.push(`   When: ${fmtDate(v.meetingDate)}`);
        if (v.focus) lines.push(`   Focus: ${v.focus}`);
        if (v.notes) lines.push(`   Notes: ${v.notes.split("\n")[0]}`);
        lines.push("");
      }

      await sendAgentText(ctx, lines.join("\n").trim());
    } catch (err: any) {
      logger.error(`❌ InvestorFunnelPlugin.showThisWeek: ${err?.message ?? err}`);
      await sendAgentText(ctx, "Error loading meetings.");
    }
  }

  private async showDetail(ctx: MessageContext<string>, query: string): Promise<void> {
    try {
      const all = await drizzleDb.select().from(investorContacts);
      const vc = matchVC(all, query);

      if (!vc) {
        await sendAgentText(ctx, `No VC found matching "${query}". Check /investors for the full list.`);
        return;
      }

      const emoji = STAGE_EMOJI[(vc.stage as Stage) ?? "identified"];
      const lines = [
        `${emoji} ${vc.firm}`,
        vc.name ? `Contact: ${vc.name}` : "",
        vc.website ? `Web: ${vc.website}` : "",
        vc.twitter ? `Twitter: ${vc.twitter}` : "",
        vc.linkedin ? `LinkedIn: ${vc.linkedin}` : "",
        vc.email ? `Email: ${vc.email}` : "",
        vc.telegram ? `Telegram: ${vc.telegram}` : "",
        "",
        vc.focus ? `Focus: ${vc.focus}` : "",
        vc.checkSize ? `Check: ${vc.checkSize}` : "",
        vc.stages ? `Stages: ${vc.stages}` : "",
        "",
        `Stage: ${emoji} ${vc.stage?.replace(/_/g, " ")}`,
        vc.meetingDate ? `Meeting: ${fmtDate(vc.meetingDate)}` : "",
        vc.tier ? `Tier: ${vc.tier}` : "",
        "",
        vc.notes ? `Notes:\n${vc.notes}` : "",
      ]
        .filter(Boolean)
        .join("\n");

      await sendAgentText(ctx, lines);
    } catch (err: any) {
      logger.error(`❌ InvestorFunnelPlugin.showDetail: ${err?.message ?? err}`);
      await sendAgentText(ctx, "Error loading VC details.");
    }
  }

  // ── Mutations ─────────────────────────────────────────────────────────────

  private async addVC(
    ctx: MessageContext<string>,
    name: string,
    firm: string,
    tier?: "tier1" | "tier2" | "tier3",
  ): Promise<void> {
    try {
      const [created] = await drizzleDb
        .insert(investorContacts)
        .values({
          name,
          firm,
          tier: tier ?? "tier2",
          stage: "identified",
          addedBy: ctx.message.senderInboxId,
          seeded: 0,
        })
        .returning();

      await sendAgentText(
        ctx,
        `🔍 Added ${firm} (${name}) to pipeline as ${tier ?? "tier2"}.\n\nNext: /vc stage ${firm} researching`,
      );
    } catch (err: any) {
      logger.error(`❌ InvestorFunnelPlugin.addVC: ${err?.message ?? err}`);
      await sendAgentText(ctx, "Error adding VC. Make sure format is: /vc add <name> @ <firm>");
    }
  }

  private async updateStage(
    ctx: MessageContext<string>,
    query: string,
    stageInput: string,
  ): Promise<void> {
    const stage = parseStage(stageInput);
    if (!stage) {
      await sendAgentText(
        ctx,
        `Unknown stage "${stageInput}".\n\nValid: identified · researching · outreach_sent · meeting_scheduled · meeting_done · follow_up · term_sheet · passed · on_hold`,
      );
      return;
    }

    try {
      const all = await drizzleDb.select().from(investorContacts);
      const vc = matchVC(all, query);

      if (!vc) {
        await sendAgentText(ctx, `No VC found matching "${query}".`);
        return;
      }

      await drizzleDb
        .update(investorContacts)
        .set({ stage, updatedAt: new Date() })
        .where(eq(investorContacts.id, vc.id));

      const emoji = STAGE_EMOJI[stage];
      await sendAgentText(ctx, `${emoji} ${vc.firm} → ${stage.replace(/_/g, " ")}`);
    } catch (err: any) {
      logger.error(`❌ InvestorFunnelPlugin.updateStage: ${err?.message ?? err}`);
      await sendAgentText(ctx, "Error updating stage.");
    }
  }

  private async addNote(
    ctx: MessageContext<string>,
    query: string,
    note: string,
  ): Promise<void> {
    try {
      const all = await drizzleDb.select().from(investorContacts);
      const vc = matchVC(all, query);

      if (!vc) {
        await sendAgentText(ctx, `No VC found matching "${query}".`);
        return;
      }

      const ts = new Date().toLocaleDateString("en-SG", { month: "short", day: "numeric" });
      const updated = vc.notes ? `${vc.notes}\n[${ts}] ${note}` : `[${ts}] ${note}`;

      await drizzleDb
        .update(investorContacts)
        .set({ notes: updated, updatedAt: new Date() })
        .where(eq(investorContacts.id, vc.id));

      await sendAgentText(ctx, `📝 Note added to ${vc.firm}.`);
    } catch (err: any) {
      logger.error(`❌ InvestorFunnelPlugin.addNote: ${err?.message ?? err}`);
      await sendAgentText(ctx, "Error adding note.");
    }
  }

  private async scheduleMeeting(
    ctx: MessageContext<string>,
    query: string,
    dateInput: string,
  ): Promise<void> {
    const date = parseMeetingDate(dateInput);
    if (!date) {
      await sendAgentText(
        ctx,
        `Couldn't parse date "${dateInput}". Try: thursday · friday · "Aug 8" · tomorrow`,
      );
      return;
    }

    try {
      const all = await drizzleDb.select().from(investorContacts);
      const vc = matchVC(all, query);

      if (!vc) {
        await sendAgentText(ctx, `No VC found matching "${query}".`);
        return;
      }

      await drizzleDb
        .update(investorContacts)
        .set({
          meetingDate: date,
          stage: "meeting_scheduled",
          updatedAt: new Date(),
        })
        .where(eq(investorContacts.id, vc.id));

      await sendAgentText(
        ctx,
        `📅 Meeting with ${vc.firm} locked in for ${fmtDate(date)}.\n\nStage → meeting_scheduled. Good luck 🤝`,
      );
    } catch (err: any) {
      logger.error(`❌ InvestorFunnelPlugin.scheduleMeeting: ${err?.message ?? err}`);
      await sendAgentText(ctx, "Error scheduling meeting.");
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async getThisWeekMeetings(): Promise<InvestorContact[]> {
    const now = new Date();
    const startOfWeek = new Date(now);
    startOfWeek.setHours(0, 0, 0, 0);

    const endOfWeek = new Date(now);
    endOfWeek.setDate(endOfWeek.getDate() + (7 - endOfWeek.getDay()));
    endOfWeek.setHours(23, 59, 59, 999);

    return drizzleDb
      .select()
      .from(investorContacts)
      .where(
        and(
          isNotNull(investorContacts.meetingDate),
          gte(investorContacts.meetingDate, startOfWeek),
          lte(investorContacts.meetingDate, endOfWeek),
        ),
      )
      .orderBy(investorContacts.meetingDate);
  }
}
