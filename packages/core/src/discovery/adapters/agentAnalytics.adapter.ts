import { db } from "@/discovery/db.js";
import { ProtocolVolumeAdapter } from "@/discovery/adapters/protocolVolume.adapter.js";
import { getBankrLaunchedTokenMarketStats } from "@/discovery/services/bankrVolume.service.js";

const DEFAULT_INSTANCE_ID = "basemate";

export interface ProtocolFlowMetric {
  users: number;
  clicks: number;
  clicks24h: number;
  confirmedVolumeUsdc: string;
  volume24hUsdc: string;
  confirmedTxCount: number;
}

export interface BankrFlowMetric {
  totalLaunches: number;
  launches24h: number;
  failedLaunches: number;
  tradingVolume24hUsdc: number;
  tradingVolumeLifetimeUsdc: number;
}

export interface AgentAnalyticsSummary {
  generatedAt: string;
  instanceId: string;
  groups: {
    agentInGroup: number;
    totalKnown: number;
    suggestable: number;
    boostedActive: number;
    totalMembersInAgentGroups: number;
    messagesObservedInAgentGroups: number;
  };
  users: {
    total: number;
    withWallet: number;
    messagesReceived: number;
    remindersCreated: number;
    proactiveDmsSent: number;
    proactiveDmsLast24h: number;
  };
  recommendations: {
    pending: number;
    sent: number;
    failed: number;
    sentLast24h: number;
  };
  activity: {
    last24h: {
      messages: number;
      memberJoins: number;
      memberLeaves: number;
      uniqueActiveUsers: number;
    };
    last7d: {
      messages: number;
      memberJoins: number;
      memberLeaves: number;
      uniqueActiveUsers: number;
    };
  };
  keywords: {
    active: number;
    totalImpressions: number;
    impressionsLast24h: number;
    totalSpentUsdc: string;
  };
  tokenLaunches: {
    allTime: {
      success: number;
      failed: number;
    };
    last24h: {
      success: number;
      failed: number;
    };
  };
  copyTradeSubscriptions: number;
  boost: {
    paymentCount: number;
    totalRevenueUsdc: string;
  };
  engagement: {
    buttonClicksLifetime: number;
    buttonClicksLast24h: number;
    topButtonActions: Array<{ action: string; count: number }>;
  };
  legacyGroups?: {
    activeGroups: number;
    totalMessages: number;
    totalMentionedMessages: number;
  };
  protocolFlow: {
    moonwell: ProtocolFlowMetric;
    morpho: ProtocolFlowMetric;
    aave: ProtocolFlowMetric;
    avantis: ProtocolFlowMetric & {
      copyVolumeUsdc: string;
      copyVolume24hUsdc: string;
      confirmedNotionalUsdc: string;
      notional24hUsdc: string;
      copyNotionalUsdc: string;
      copyNotional24hUsdc: string;
    };
    uniswap: ProtocolFlowMetric;
    aerodrome: ProtocolFlowMetric;
    bankr: BankrFlowMetric;
  };
  tradingVolume?: {
    /** Perp + swap notional (excludes yield). */
    lifetimeUsdc: string;
    last24hUsdc: string;
    /** User perp margin (collateral). */
    perpsUsdc: string;
    perps24hUsdc: string;
    /** User perp notional (margin × leverage). */
    perpsNotionalUsdc: string;
    perpsNotional24hUsdc: string;
    /** Server-wallet perp margin. */
    serverWalletUsdc: string;
    serverWallet24hUsdc: string;
    /** Server-wallet perp notional. */
    serverWalletNotionalUsdc: string;
    serverWalletNotional24hUsdc: string;
    yieldUsdc: string;
    yield24hUsdc: string;
    swapsUsdc: string;
    swaps24hUsdc: string;
    uniswapUsdc: string;
    uniswap24hUsdc: string;
    aerodromeUsdc: string;
    aerodrome24hUsdc: string;
  };
  worldCupBetting?: {
    betsPlacedLifetime: number;
    betsPlaced24h: number;
    basemateWageredLifetime: string;
    basemateWagered24h: string;
  };
  /** CDP + server wallets used for iMessage and Base app automations. */
  basemateWallets?: {
    activeWallets: number;
    cdpWallets: number;
    publishedStrategies: number;
    perpOpensLifetime: number;
    perpOpens24h: number;
    openPositions: number;
    activeSubscriptions: number;
    marginLifetimeUsdc: string;
    margin24hUsdc: string;
    notionalLifetimeUsdc: string;
    notional24hUsdc: string;
  };
}

function instanceFilterSql(paramIndex: number): string {
  return `(instance_id = $${paramIndex} OR instance_id IS NULL)`;
}

export class AgentAnalyticsAdapter {
  static resolveInstanceId(): string {
    return process.env.AGENT_INSTANCE_ID?.trim() || DEFAULT_INSTANCE_ID;
  }

  static async getSummary(instanceId?: string): Promise<AgentAnalyticsSummary> {
    const inst = instanceId?.trim() || this.resolveInstanceId();
    const instFilter = instanceFilterSql(1);

    const [
      groupsRes,
      usersRes,
      recsRes,
      activity24Res,
      activity7Res,
      keywordsRes,
      launchesRes,
      copyTradeRes,
      boostRes,
      buttonLifetimeRes,
      button24hRes,
      topActionsRes,
      legacyRes,
      protocolEngagementRes,
      avantisCopyVolumeRes,
      moonwellVolumeRes,
      morphoVolumeRes,
      aaveVolumeRes,
      avantisVolumeRes,
      avantisNotionalVolumeRes,
      uniswapVolumeRes,
      aerodromeVolumeRes,
      bankrMarketStats,
      worldCupRes,
      basemateWalletCountsRes,
    ] = await Promise.all([
      db.query<{
        agent_in_group: string;
        total_known: string;
        suggestable: string;
        boosted_active: string;
        total_members: string;
        total_messages: string;
      }>(
        `SELECT
           COUNT(*) FILTER (WHERE agent_in_group = true)::text AS agent_in_group,
           COUNT(*)::text AS total_known,
           COUNT(*) FILTER (WHERE is_suggestable = true AND agent_in_group = true)::text AS suggestable,
           COUNT(*) FILTER (
             WHERE paid_discovery = true
               AND agent_in_group = true
               AND (paid_discovery_expires_at IS NULL OR paid_discovery_expires_at > NOW())
           )::text AS boosted_active,
           COALESCE(SUM(total_members) FILTER (WHERE agent_in_group = true), 0)::text AS total_members,
           COALESCE(SUM(total_messages) FILTER (WHERE agent_in_group = true), 0)::text AS total_messages
         FROM ns_groups
         WHERE ${instFilter}`,
        [inst],
      ),
      db.query<{
        total: string;
        with_wallet: string;
        messages_received: string;
        reminders: string;
        proactive_total: string;
        proactive_24h: string;
      }>(
        `SELECT
           COUNT(*)::text AS total,
           COUNT(*) FILTER (WHERE wallet_address IS NOT NULL)::text AS with_wallet,
           (
             (SELECT COALESCE(SUM(total_messages), 0) FROM users) +
             (SELECT COALESCE(SUM(message_count), 0) FROM group_activity_hourly)
           )::text AS messages_received,
           COALESCE(SUM(reminders_created), 0)::text AS reminders,
           COUNT(*) FILTER (WHERE last_proactive_dm_at IS NOT NULL)::text AS proactive_total,
           COUNT(*) FILTER (WHERE last_proactive_dm_at >= NOW() - INTERVAL '24 hours')::text AS proactive_24h
         FROM users`,
      ),
      db.query<{
        pending: string;
        sent: string;
        failed: string;
        sent_24h: string;
      }>(
        `SELECT
           COUNT(*) FILTER (WHERE status = 'pending')::text AS pending,
           COUNT(*) FILTER (WHERE status = 'sent')::text AS sent,
           COUNT(*) FILTER (WHERE status = 'failed')::text AS failed,
           COUNT(*) FILTER (
             WHERE status = 'sent' AND sent_at >= NOW() - INTERVAL '24 hours'
           )::text AS sent_24h
         FROM pending_recommendations`,
      ),
      activityWindowSql("24 hours"),
      activityWindowSql("7 days"),
      db.query<{
        active: string;
        impressions: string;
        impressions_24h: string;
        spent: string;
      }>(
        `SELECT
           (SELECT COUNT(*) FROM keywords WHERE status = 'active')::text AS active,
           (SELECT COUNT(*) FROM keyword_impressions)::text AS impressions,
           (SELECT COUNT(*) FROM keyword_impressions
            WHERE created_at >= NOW() - INTERVAL '24 hours')::text AS impressions_24h,
           (SELECT COALESCE(SUM(spent_usdc), 0)::text FROM keyword_budgets) AS spent`,
      ),
      db.query<{
        success: string;
        failed: string;
        success_24h: string;
        failed_24h: string;
      }>(
        `SELECT
           COUNT(*) FILTER (WHERE status = 'success')::text AS success,
           COUNT(*) FILTER (WHERE status = 'failed')::text AS failed,
           COUNT(*) FILTER (
             WHERE status = 'success' AND created_at >= NOW() - INTERVAL '24 hours'
           )::text AS success_24h,
           COUNT(*) FILTER (
             WHERE status = 'failed' AND created_at >= NOW() - INTERVAL '24 hours'
           )::text AS failed_24h
         FROM token_launch_log`,
      ),
      countCopyTradeSubscriptions(),
      db.query<{ count: string; revenue: string }>(
        `SELECT
           COUNT(*)::text AS count,
           COALESCE(SUM(amount_usdc), 0)::text AS revenue
         FROM boost_payments`,
      ),
      db.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM button_click_events`),
      db.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM button_click_events
         WHERE clicked_at >= NOW() - INTERVAL '24 hours'`,
      ),
      db.query<{ action_key: string; count: string }>(
        `SELECT action_key, COUNT(*)::text AS count
         FROM button_click_events
         GROUP BY action_key
         ORDER BY COUNT(*) DESC
         LIMIT 15`,
      ),
      db.query<{
        active: string;
        messages: string;
        mentioned: string;
      }>(
        `SELECT
           COUNT(*) FILTER (WHERE is_active = true)::text AS active,
           COALESCE(SUM(total_messages), 0)::text AS messages,
           COALESCE(SUM(total_mentioned_messages), 0)::text AS mentioned
         FROM groups`,
      ).catch(() => ({ rows: [] as never[] })),
      protocolEngagementSql(),
      sumStrategyTradeVolume(),
      ProtocolVolumeAdapter.sumByProtocol("moonwell"),
      ProtocolVolumeAdapter.sumByProtocol("morpho"),
      ProtocolVolumeAdapter.sumByProtocol("aave"),
      ProtocolVolumeAdapter.sumByProtocol("avantis"),
      ProtocolVolumeAdapter.sumNotionalByProtocol("avantis"),
      ProtocolVolumeAdapter.sumByProtocol("uniswap"),
      ProtocolVolumeAdapter.sumByProtocol("aerodrome"),
      getBankrLaunchedTokenMarketStats().catch(() => ({
        tradingVolume24hUsdc: 0,
        tradingVolumeLifetimeUsdc: 0,
      })),
      sumWorldCupBetting().catch(() => null),
      sumBasemateWalletCounts(),
    ]);

    const g = groupsRes.rows[0];
    const u = usersRes.rows[0];
    const r = recsRes.rows[0];
    const a24 = activity24Res.rows[0];
    const a7 = activity7Res.rows[0];
    const kw = keywordsRes.rows[0];
    const tl = launchesRes.rows[0];
    const legacy = legacyRes.rows[0];
    const pe = protocolEngagementRes.rows[0];
    const avCopy = avantisCopyVolumeRes.rows[0];
    const wc = worldCupRes;

    const perpsLifetime = avantisVolumeRes.allTimeUsdc;
    const perps24h = avantisVolumeRes.last24hUsdc;
    const perpsNotionalLifetime = avantisNotionalVolumeRes.allTimeUsdc;
    const perpsNotional24h = avantisNotionalVolumeRes.last24hUsdc;
    const serverLifetime = avCopy?.margin_all_time ?? "0";
    const server24h = avCopy?.margin_24h ?? "0";
    const serverNotionalLifetime = avCopy?.notional_all_time ?? "0";
    const serverNotional24h = avCopy?.notional_24h ?? "0";
    const yieldLifetime =
      Number(moonwellVolumeRes.allTimeUsdc) +
      Number(morphoVolumeRes.allTimeUsdc) +
      Number(aaveVolumeRes.allTimeUsdc);
    const yield24h =
      Number(moonwellVolumeRes.last24hUsdc) +
      Number(morphoVolumeRes.last24hUsdc) +
      Number(aaveVolumeRes.last24hUsdc);
    const swapsLifetime =
      Number(uniswapVolumeRes.allTimeUsdc) +
      Number(aerodromeVolumeRes.allTimeUsdc);
    const swaps24h =
      Number(uniswapVolumeRes.last24hUsdc) +
      Number(aerodromeVolumeRes.last24hUsdc);
    const lifetimeTotal =
      Number(perpsNotionalLifetime) +
      Number(serverNotionalLifetime) +
      swapsLifetime;
    const last24hTotal =
      Number(perpsNotional24h) +
      Number(serverNotional24h) +
      swaps24h;

    const summary: AgentAnalyticsSummary = {
      generatedAt: new Date().toISOString(),
      instanceId: inst,
      groups: {
        agentInGroup: Number(g?.agent_in_group ?? 0),
        totalKnown: Number(g?.total_known ?? 0),
        suggestable: Number(g?.suggestable ?? 0),
        boostedActive: Number(g?.boosted_active ?? 0),
        totalMembersInAgentGroups: Number(g?.total_members ?? 0),
        messagesObservedInAgentGroups: Number(g?.total_messages ?? 0),
      },
      users: {
        total: Number(u?.total ?? 0),
        withWallet: Number(u?.with_wallet ?? 0),
        messagesReceived: Number(u?.messages_received ?? 0),
        remindersCreated: Number(u?.reminders ?? 0),
        proactiveDmsSent: Number(u?.proactive_total ?? 0),
        proactiveDmsLast24h: Number(u?.proactive_24h ?? 0),
      },
      recommendations: {
        pending: Number(r?.pending ?? 0),
        sent: Number(r?.sent ?? 0),
        failed: Number(r?.failed ?? 0),
        sentLast24h: Number(r?.sent_24h ?? 0),
      },
      activity: {
        last24h: parseActivityRow(a24),
        last7d: parseActivityRow(a7),
      },
      keywords: {
        active: Number(kw?.active ?? 0),
        totalImpressions: Number(kw?.impressions ?? 0),
        impressionsLast24h: Number(kw?.impressions_24h ?? 0),
        totalSpentUsdc: kw?.spent ?? "0",
      },
      tokenLaunches: {
        allTime: {
          success: Number(tl?.success ?? 0),
          failed: Number(tl?.failed ?? 0),
        },
        last24h: {
          success: Number(tl?.success_24h ?? 0),
          failed: Number(tl?.failed_24h ?? 0),
        },
      },
      copyTradeSubscriptions: Number(copyTradeRes.rows[0]?.count ?? 0),
      boost: {
        paymentCount: Number(boostRes.rows[0]?.count ?? 0),
        totalRevenueUsdc: boostRes.rows[0]?.revenue ?? "0",
      },
      engagement: {
        buttonClicksLifetime: Number(buttonLifetimeRes.rows[0]?.count ?? 0),
        buttonClicksLast24h: Number(button24hRes.rows[0]?.count ?? 0),
        topButtonActions: topActionsRes.rows.map((row: { action_key: string; count: string }) => ({
          action: row.action_key,
          count: Number(row.count),
        })),
      },
      protocolFlow: {
        moonwell: buildProtocolFlowMetric(pe, "moonwell", moonwellVolumeRes),
        morpho: buildProtocolFlowMetric(pe, "morpho", morphoVolumeRes),
        aave: buildProtocolFlowMetric(pe, "aave", aaveVolumeRes),
        avantis: {
          ...buildProtocolFlowMetric(pe, "avantis", avantisVolumeRes),
          confirmedNotionalUsdc: perpsNotionalLifetime,
          notional24hUsdc: perpsNotional24h,
          copyVolumeUsdc: serverLifetime,
          copyVolume24hUsdc: server24h,
          copyNotionalUsdc: serverNotionalLifetime,
          copyNotional24hUsdc: serverNotional24h,
        },
        uniswap: buildVolumeOnlyMetric(uniswapVolumeRes),
        aerodrome: buildVolumeOnlyMetric(aerodromeVolumeRes),
        bankr: {
          totalLaunches: Number(tl?.success ?? 0),
          launches24h: Number(tl?.success_24h ?? 0),
          failedLaunches: Number(tl?.failed ?? 0),
          tradingVolume24hUsdc: bankrMarketStats.tradingVolume24hUsdc,
          tradingVolumeLifetimeUsdc: bankrMarketStats.tradingVolumeLifetimeUsdc,
        },
      },
      tradingVolume: {
        lifetimeUsdc: String(lifetimeTotal),
        last24hUsdc: String(last24hTotal),
        perpsUsdc: perpsLifetime,
        perps24hUsdc: perps24h,
        perpsNotionalUsdc: perpsNotionalLifetime,
        perpsNotional24hUsdc: perpsNotional24h,
        serverWalletUsdc: serverLifetime,
        serverWallet24hUsdc: server24h,
        serverWalletNotionalUsdc: serverNotionalLifetime,
        serverWalletNotional24hUsdc: serverNotional24h,
        yieldUsdc: String(yieldLifetime),
        yield24hUsdc: String(yield24h),
        swapsUsdc: String(swapsLifetime),
        swaps24hUsdc: String(swaps24h),
        uniswapUsdc: uniswapVolumeRes.allTimeUsdc,
        uniswap24hUsdc: uniswapVolumeRes.last24hUsdc,
        aerodromeUsdc: aerodromeVolumeRes.allTimeUsdc,
        aerodrome24hUsdc: aerodromeVolumeRes.last24hUsdc,
      },
    };

    if (wc) {
      summary.worldCupBetting = wc;
    }

    summary.basemateWallets = {
      activeWallets: basemateWalletCountsRes.activeWallets,
      cdpWallets: basemateWalletCountsRes.cdpWallets,
      publishedStrategies: basemateWalletCountsRes.publishedStrategies,
      perpOpensLifetime: basemateWalletCountsRes.perpOpensLifetime,
      perpOpens24h: basemateWalletCountsRes.perpOpens24h,
      openPositions: basemateWalletCountsRes.openPositions,
      activeSubscriptions: Number(copyTradeRes.rows[0]?.count ?? 0),
      marginLifetimeUsdc: serverLifetime,
      margin24hUsdc: server24h,
      notionalLifetimeUsdc: serverNotionalLifetime,
      notional24hUsdc: serverNotional24h,
    };

    if (legacy?.active != null) {
      summary.legacyGroups = {
        activeGroups: Number(legacy.active),
        totalMessages: Number(legacy.messages),
        totalMentionedMessages: Number(legacy.mentioned),
      };
    }

    return summary;
  }
}

function parseActivityRow(row?: {
  messages: string;
  member_joins: string;
  member_leaves: string;
  unique_active_users: string;
}): AgentAnalyticsSummary["activity"]["last24h"] {
  return {
    messages: Number(row?.messages ?? 0),
    memberJoins: Number(row?.member_joins ?? 0),
    memberLeaves: Number(row?.member_leaves ?? 0),
    uniqueActiveUsers: Number(row?.unique_active_users ?? 0),
  };
}

function activityWindowSql(interval: string) {
  return db.query<{
    messages: string;
    member_joins: string;
    member_leaves: string;
    unique_active_users: string;
  }>(
    `SELECT
       (
         (SELECT COALESCE(SUM(message_count), 0)
          FROM group_activity_hourly
          WHERE hour_bucket >= NOW() - INTERVAL '${interval}')
         +
         (SELECT COUNT(*)
          FROM inbound_message_events
          WHERE engaged = true
            AND received_at >= NOW() - INTERVAL '${interval}')
       )::text AS messages,
       (SELECT COALESCE(SUM(member_joins), 0)
        FROM group_activity_hourly
        WHERE hour_bucket >= NOW() - INTERVAL '${interval}')::text AS member_joins,
       (SELECT COALESCE(SUM(member_leaves), 0)
        FROM group_activity_hourly
        WHERE hour_bucket >= NOW() - INTERVAL '${interval}')::text AS member_leaves,
       (
         SELECT COUNT(DISTINCT all_ids.id)::text
         FROM (
           SELECT uid AS id
           FROM group_activity_hourly gah,
           LATERAL unnest(COALESCE(gah.active_user_ids, ARRAY[]::text[])) AS uid
           WHERE gah.hour_bucket >= NOW() - INTERVAL '${interval}'
           UNION
           SELECT inbox_id AS id
           FROM button_click_events
           WHERE clicked_at >= NOW() - INTERVAL '${interval}'
           UNION
           SELECT inbox_id AS id
           FROM users
           WHERE last_message_at >= NOW() - INTERVAL '${interval}'
         ) AS all_ids
       ) AS unique_active_users`,
  );
}

function protocolEngagementSql() {
  return db.query<{
    moonwell_clicks: string;
    moonwell_users: string;
    moonwell_clicks_24h: string;
    morpho_clicks: string;
    morpho_users: string;
    morpho_clicks_24h: string;
    aave_clicks: string;
    aave_users: string;
    aave_clicks_24h: string;
    avantis_clicks: string;
    avantis_users: string;
    avantis_clicks_24h: string;
    bankr_clicks: string;
    bankr_users: string;
    bankr_clicks_24h: string;
  }>(
    `SELECT
       COUNT(*) FILTER (WHERE action_key LIKE 'dis_moonwell_%' OR action_key LIKE 'amt_moonwell_%')::text AS moonwell_clicks,
       COUNT(DISTINCT inbox_id) FILTER (WHERE action_key LIKE 'dis_moonwell_%' OR action_key LIKE 'amt_moonwell_%')::text AS moonwell_users,
       COUNT(*) FILTER (WHERE (action_key LIKE 'dis_moonwell_%' OR action_key LIKE 'amt_moonwell_%') AND clicked_at >= NOW() - INTERVAL '24 hours')::text AS moonwell_clicks_24h,
       COUNT(*) FILTER (WHERE action_key LIKE 'dis_morpho_%' OR action_key LIKE 'amt_morpho_%')::text AS morpho_clicks,
       COUNT(DISTINCT inbox_id) FILTER (WHERE action_key LIKE 'dis_morpho_%' OR action_key LIKE 'amt_morpho_%')::text AS morpho_users,
       COUNT(*) FILTER (WHERE (action_key LIKE 'dis_morpho_%' OR action_key LIKE 'amt_morpho_%') AND clicked_at >= NOW() - INTERVAL '24 hours')::text AS morpho_clicks_24h,
       COUNT(*) FILTER (WHERE action_key LIKE 'dis_aave_%' OR action_key LIKE 'amt_aave_%')::text AS aave_clicks,
       COUNT(DISTINCT inbox_id) FILTER (WHERE action_key LIKE 'dis_aave_%' OR action_key LIKE 'amt_aave_%')::text AS aave_users,
       COUNT(*) FILTER (WHERE (action_key LIKE 'dis_aave_%' OR action_key LIKE 'amt_aave_%') AND clicked_at >= NOW() - INTERVAL '24 hours')::text AS aave_clicks_24h,
       COUNT(*) FILTER (WHERE action_key LIKE 'cap_perp_%' OR action_key LIKE 'perp_%' OR action_key = 'menu_perps')::text AS avantis_clicks,
       COUNT(DISTINCT inbox_id) FILTER (WHERE action_key LIKE 'cap_perp_%' OR action_key LIKE 'perp_%' OR action_key = 'menu_perps')::text AS avantis_users,
       COUNT(*) FILTER (WHERE (action_key LIKE 'cap_perp_%' OR action_key LIKE 'perp_%' OR action_key = 'menu_perps') AND clicked_at >= NOW() - INTERVAL '24 hours')::text AS avantis_clicks_24h,
       COUNT(*) FILTER (WHERE action_key = 'cap_launch' OR action_key = 'menu_launch' OR action_key LIKE 'launch_%' OR action_key LIKE 'buy_%' OR action_key LIKE 'bankr_%')::text AS bankr_clicks,
       COUNT(DISTINCT inbox_id) FILTER (WHERE action_key = 'cap_launch' OR action_key = 'menu_launch' OR action_key LIKE 'launch_%' OR action_key LIKE 'buy_%' OR action_key LIKE 'bankr_%')::text AS bankr_users,
       COUNT(*) FILTER (WHERE (action_key = 'cap_launch' OR action_key = 'menu_launch' OR action_key LIKE 'launch_%' OR action_key LIKE 'buy_%' OR action_key LIKE 'bankr_%') AND clicked_at >= NOW() - INTERVAL '24 hours')::text AS bankr_clicks_24h
     FROM button_click_events`,
  );
}

/** Active Prompt-a-Strategy followers (copy-trading tables were removed). */
async function countCopyTradeSubscriptions(): Promise<{ rows: [{ count: string }] }> {
  try {
    const res = await db.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM strategy_subscriptions WHERE status = 'active'`,
    );
    return { rows: [{ count: String(res.rows[0]?.count ?? 0) }] };
  } catch {
    return { rows: [{ count: "0" }] };
  }
}

async function sumBasemateWalletCounts(): Promise<{
  activeWallets: number;
  cdpWallets: number;
  publishedStrategies: number;
  perpOpensLifetime: number;
  perpOpens24h: number;
  openPositions: number;
}> {
  const empty = {
    activeWallets: 0,
    cdpWallets: 0,
    publishedStrategies: 0,
    perpOpensLifetime: 0,
    perpOpens24h: 0,
    openPositions: 0,
  };

  try {
    const res = await db.query<{
      active_wallets: string;
      cdp_wallets: string;
      published_strategies: string;
      perp_opens_lifetime: string;
      perp_opens_24h: string;
      open_positions: string;
    }>(
      `SELECT
         (SELECT COUNT(DISTINCT execution_wallet_address)
          FROM strategies
          WHERE status = 'published'
            AND execution_wallet_address IS NOT NULL)::text AS active_wallets,
         (SELECT COUNT(DISTINCT execution_wallet_address)
          FROM strategies
          WHERE status = 'published'
            AND execution_wallet_address IS NOT NULL
            AND execution_wallet_name LIKE 'cp-%')::text AS cdp_wallets,
         (SELECT COUNT(*)
          FROM strategies
          WHERE status = 'published')::text AS published_strategies,
         (SELECT COUNT(*)
          FROM strategy_trades
          WHERE is_paper = false)::text AS perp_opens_lifetime,
         (SELECT COUNT(*)
          FROM strategy_trades
          WHERE is_paper = false
            AND created_at >= NOW() - INTERVAL '24 hours')::text AS perp_opens_24h,
         (SELECT COUNT(*)
          FROM strategy_trades
          WHERE is_paper = false
            AND closed_at IS NULL)::text AS open_positions`,
    );
    const row = res.rows[0];
    if (!row) return empty;
    return {
      activeWallets: Number(row.active_wallets),
      cdpWallets: Number(row.cdp_wallets),
      publishedStrategies: Number(row.published_strategies),
      perpOpensLifetime: Number(row.perp_opens_lifetime),
      perpOpens24h: Number(row.perp_opens_24h),
      openPositions: Number(row.open_positions),
    };
  } catch {
    return empty;
  }
}

/** Server-wallet perp margin + notional from live strategy_trades only (exclude paper). */
async function sumStrategyTradeVolume(): Promise<{
  rows: Array<{
    margin_all_time: string;
    margin_24h: string;
    notional_all_time: string;
    notional_24h: string;
  }>;
}> {
  try {
    return await db.query<{
      margin_all_time: string;
      margin_24h: string;
      notional_all_time: string;
      notional_24h: string;
    }>(
      `SELECT
         COALESCE(SUM(st.collateral_usdc), 0)::text AS margin_all_time,
         COALESCE(SUM(st.collateral_usdc) FILTER (
           WHERE st.created_at >= NOW() - INTERVAL '24 hours'
         ), 0)::text AS margin_24h,
         COALESCE(SUM(
           st.collateral_usdc * GREATEST(
             COALESCE(st.leverage, (s.config->>'maxLeverage')::numeric, 1),
             1
           )
         ), 0)::text AS notional_all_time,
         COALESCE(SUM(
           st.collateral_usdc * GREATEST(
             COALESCE(st.leverage, (s.config->>'maxLeverage')::numeric, 1),
             1
           )
         ) FILTER (
           WHERE st.created_at >= NOW() - INTERVAL '24 hours'
         ), 0)::text AS notional_24h
       FROM strategy_trades st
       JOIN strategies s ON s.id = st.strategy_id
       WHERE st.is_paper = false`,
    );
  } catch {
    return {
      rows: [
        {
          margin_all_time: "0",
          margin_24h: "0",
          notional_all_time: "0",
          notional_24h: "0",
        },
      ],
    };
  }
}

const PLACED_BET_STATUSES = `'active','awaiting_settlement','settled','refunded','needs_manual_review'`;

async function sumWorldCupBetting(): Promise<AgentAnalyticsSummary["worldCupBetting"]> {
  const res = await db.query<{
    bets_lifetime: string;
    bets_24h: string;
    wagered_lifetime: string;
    wagered_24h: string;
  }>(
    `SELECT
       COUNT(*) FILTER (WHERE status IN (${PLACED_BET_STATUSES}))::text AS bets_lifetime,
       COUNT(*) FILTER (
         WHERE status IN (${PLACED_BET_STATUSES})
           AND matched_at >= NOW() - INTERVAL '24 hours'
       )::text AS bets_24h,
       COALESCE(SUM(bettor_a_amount) FILTER (
         WHERE status IN (${PLACED_BET_STATUSES})
       ), 0)::text AS wagered_lifetime,
       COALESCE(SUM(bettor_a_amount) FILTER (
         WHERE status IN (${PLACED_BET_STATUSES})
           AND matched_at >= NOW() - INTERVAL '24 hours'
       ), 0)::text AS wagered_24h
     FROM world_cup_bets`,
  );
  const row = res.rows[0];
  if (!row) return undefined;
  return {
    betsPlacedLifetime: Number(row.bets_lifetime),
    betsPlaced24h: Number(row.bets_24h),
    basemateWageredLifetime: row.wagered_lifetime,
    basemateWagered24h: row.wagered_24h,
  };
}

function buildProtocolFlowMetric(
  row: {
    moonwell_clicks: string;
    moonwell_users: string;
    moonwell_clicks_24h: string;
    morpho_clicks: string;
    morpho_users: string;
    morpho_clicks_24h: string;
    aave_clicks: string;
    aave_users: string;
    aave_clicks_24h: string;
    avantis_clicks: string;
    avantis_users: string;
    avantis_clicks_24h: string;
  } | undefined,
  protocol: "moonwell" | "morpho" | "aave" | "avantis",
  volume: Awaited<ReturnType<typeof ProtocolVolumeAdapter.sumByProtocol>>,
): ProtocolFlowMetric {
  const clicks =
    protocol === "moonwell"
      ? Number(row?.moonwell_clicks ?? 0)
      : protocol === "morpho"
        ? Number(row?.morpho_clicks ?? 0)
        : protocol === "aave"
          ? Number(row?.aave_clicks ?? 0)
          : Number(row?.avantis_clicks ?? 0);
  const users =
    protocol === "moonwell"
      ? Number(row?.moonwell_users ?? 0)
      : protocol === "morpho"
        ? Number(row?.morpho_users ?? 0)
        : protocol === "aave"
          ? Number(row?.aave_users ?? 0)
          : Number(row?.avantis_users ?? 0);
  const clicks24h =
    protocol === "moonwell"
      ? Number(row?.moonwell_clicks_24h ?? 0)
      : protocol === "morpho"
        ? Number(row?.morpho_clicks_24h ?? 0)
        : protocol === "aave"
          ? Number(row?.aave_clicks_24h ?? 0)
          : Number(row?.avantis_clicks_24h ?? 0);

  return {
    clicks,
    users,
    clicks24h,
    confirmedVolumeUsdc: volume.allTimeUsdc,
    volume24hUsdc: volume.last24hUsdc,
    confirmedTxCount: volume.txCount,
  };
}

function buildVolumeOnlyMetric(
  volume: Awaited<ReturnType<typeof ProtocolVolumeAdapter.sumByProtocol>>,
): ProtocolFlowMetric {
  return {
    users: 0,
    clicks: 0,
    clicks24h: 0,
    confirmedVolumeUsdc: volume.allTimeUsdc,
    volume24hUsdc: volume.last24hUsdc,
    confirmedTxCount: volume.txCount,
  };
}
