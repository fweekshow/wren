import {
  Agent,
  AgentError,
  AgentStreamingError,
  Client,
  filter,
  MessageContext,
} from "@xmtp/agent-sdk";

import { logger } from "@/utils/logger.js";
import {
  inlineActionsMiddleware,
  registerAction,
} from "@/xmtp/content-types/inline-actions/index.js";
import { IntentCodec } from "@/xmtp/content-types/inline-actions/types/index.js";
import {
  groupMessageFilterMiddleware,
  loggingMiddleware,
} from "@/xmtp/middleware/index.js";

import { XMTPClient } from "./client.js";
import { ServiceRegistry } from "./serviceRegistry.js";
import { ActionHandler, CommandEntry, XMTPServicePlugin } from "./types.js";
import { sendReaction } from "./utils.js";
import { extractReplyText, shouldEngageInGroup } from "./groupEngagement.js";

export class XMTPBase {
  private agent: Agent | null = null;
  private client: Client<any> | null = null;
  private registry: ServiceRegistry;
  private isOutboxDraining = false;
  private streamRestartScheduled = false;

  constructor() {
    this.registry = new ServiceRegistry();
  }

  use(plugin: XMTPServicePlugin): this {
    this.registry.register(plugin);
    return this;
  }

  async init(): Promise<void> {
    logger.info("=".repeat(60));
    logger.info("🚀 XMTP Base Initialization");
    logger.info("=".repeat(60));

    const xmtpClient = new XMTPClient();
    this.agent = await xmtpClient.createAgent();
    this.client = this.agent.client;

    await this.registry.initializeAll(this.client, this.agent);

    this.setupMiddleware();
    this.setupStreamRecovery();

    // supportRequestProcessor.initialize(this.client);
    // supportRequestProcessor.start();

    logger.info("=".repeat(60));
    logger.info("✅ XMTP Base Ready");
    logger.info("=".repeat(60));
  }

  async start(): Promise<void> {
    if (!this.agent) {
      throw new Error("XMTP Base not initialized. Call init() first.");
    }

    logger.info("🎬 Starting XMTP Agent...\n");
    logger.info("🔄 Agent SDK client initialized with Quick Actions codecs");
    logger.info(`✓ Agent Address: ${this.agent.address}`);
    logger.info(`✓ Agent Inbox ID: ${this.agent.client.inboxId}`);
    // logger.info(`🔍 ContentTypeActions:`, ContentTypeActions.toString());

    await this.handleCallbacks();

    await this.startAgentStreams();
    logger.info("🎉 XMTP Agent is now running!\n");

    await this.reconcileAgentMembership();
    this.startOutboxDrain();
    this.startMemberSnapshotLoop();
  }

  /**
   * Sync the local XMTP DB with the network, then reconcile Postgres
   * `agent_in_group` against the live membership list. Run once on startup
   * (after agent.start) and any time we suspect drift.
   *
   * Without this, a wallet/inbox change leaves stale `agent_in_group=true`
   * rows behind and discovery keeps surfacing groups we can no longer
   * add users to.
   */
  private async reconcileAgentMembership(): Promise<void> {
    if (!this.client) return;

    logger.info("🔁 Reconciling agent group membership...");
    try {
      // sync() only — syncAll() re-processes historical welcomes and can trigger
      // HPKE errors that stop the agent-sdk stream without a clear app log.
      await this.client.conversations.sync();
    } catch (err: any) {
      logger.warn(`⚠️ conversations.sync() failed (continuing): ${err?.message || err}`);
    }

    const groups = this.client.conversations.listGroups();
    const liveIds = groups.map((g: any) => g.id as string);

    const { NSGroupAdapter } = await import("@/discovery/adapters/nsGroup.adapter.js");
    const result = await NSGroupAdapter.reconcileAgentMembership(liveIds);
    NSGroupAdapter.invalidateAgentGroupIdSet();

    logger.info(
      `✅ Membership reconcile complete: in=${result.inCount}, ` +
      `reactivated=${result.reactivatedCount}, cleared=${result.clearedCount}, ` +
      `failedPending=${result.failedPending}`,
    );
  }

  /**
   * Periodically snapshot the live member count of every group Basemate is in.
   *
   * Writes one row per group per day into `group_member_snapshots` (the latest
   * read of the day wins). This is the source of truth for accurate member
   * growth over any window — unlike the legacy member_joins counter, it records
   * the real count so joins = current_count - count_at_window_start.
   *
   * Runs once shortly after startup (so the daily series has a fresh point on
   * every deploy) and then every 24h.
   */
  private startMemberSnapshotLoop(): void {
    const SNAPSHOT_INTERVAL = 24 * 60 * 60 * 1000; // 24h
    const FIRST_RUN_DELAY = 60_000; // let conversation sync settle after start

    setTimeout(() => {
      this.captureMemberSnapshots().catch((err) =>
        logger.error(`❌ Initial member snapshot failed: ${err?.message || err}`),
      );
    }, FIRST_RUN_DELAY);

    setInterval(() => {
      this.captureMemberSnapshots().catch((err) =>
        logger.error(`❌ Scheduled member snapshot failed: ${err?.message || err}`),
      );
    }, SNAPSHOT_INTERVAL);
  }

  /**
   * Read the current member count of each group the agent is in, refresh
   * ns_groups.total_members, and persist a daily snapshot for growth tracking.
   */
  private async captureMemberSnapshots(): Promise<void> {
    if (!this.client) return;

    logger.info("📸 Capturing group member snapshots...");
    try {
      await this.client.conversations.sync();
    } catch (err: any) {
      logger.warn(`⚠️ sync() before snapshot failed (continuing): ${err?.message || err}`);
    }

    const groups = this.client.conversations.listGroups();

    // Use the same reconcileMemberCount path as the live join event so the
    // count, join/leave deltas, snapshots and the distinct-chatter floor all
    // stay consistent. This is the daily reconciler for anything the per-group
    // events missed.
    const { reconcileMemberCount } = await import("@/discovery/services/memberCount.js");

    let recorded = 0;
    for (const group of groups) {
      try {
        await (group as any).sync?.();
        const members = await (group as any).members();
        const memberCount = members?.length ?? 0;
        if (memberCount <= 0) continue;
        await reconcileMemberCount(group.id as string, memberCount);
        recorded++;
      } catch (err: any) {
        logger.warn(
          `⚠️ Could not read members for group ${String(group.id).slice(0, 8)}...: ${err?.message || err}`,
        );
      }
    }

    logger.info(
      `✅ Member snapshot complete: ${recorded} group(s) recorded (of ${groups.length} in-group)`,
    );
  }

  private startOutboxDrain(): void {
    const DRAIN_INTERVAL = 30_000;
    setInterval(async () => {
      if (this.isOutboxDraining) return;
      this.isOutboxDraining = true;

      try {
        const { RecommendationAdapter } = await import("@/discovery/adapters/recommendation.adapter.js");
        const rec = await RecommendationAdapter.getNextPending();
        if (!rec) return;

        try {
          if (!this.client) return;

          const { NSGroupAdapter } = await import("@/discovery/adapters/nsGroup.adapter.js");
          const memberIds = await NSGroupAdapter.getAgentGroupIdSet(true);
          if (!memberIds.has(rec.target_group_id)) {
            await RecommendationAdapter.markFailed(rec.id);
            logger.info(
              `⏭️ Outbox: skipped rec ${rec.id} — agent not in "${rec.target_group_name}"`,
            );
            return;
          }

          let targetGroup: unknown = null;
          try {
            targetGroup = await this.client.conversations.getConversationById(rec.target_group_id);
          } catch {
            targetGroup = null;
          }
          if (!targetGroup) {
            await NSGroupAdapter.updateAgentInGroup(rec.target_group_id, false);
            NSGroupAdapter.invalidateAgentGroupIdSet();
            await RecommendationAdapter.markFailed(rec.id);
            logger.info(
              `⏭️ Outbox: skipped rec ${rec.id} — "${rec.target_group_name}" not in local XMTP DB`,
            );
            return;
          }

          const identifier = rec.sender_wallet_address;
          if (!identifier) {
            await RecommendationAdapter.markFailed(rec.id);
            return;
          }

          const dm: any = await this.client.conversations.newDmWithIdentifier({
            identifier: identifier as `0x${string}`,
            identifierKind: 0,
          });

          const dmText = `Hey! Based on what you've been chatting about, you might enjoy "${rec.target_group_name}". Tap below to check it out!`;
          await dm.send(dmText);

          const { sendActions } = await import("@/xmtp/content-types/inline-actions/index.js");
          await sendActions(dm, {
            id: "proactive_recommendation",
            description: `Join ${rec.target_group_name}`,
            actions: [{
              id: `join_${rec.target_group_id.slice(0, 8)}_group`,
              label: rec.target_group_name.length > 20 ? rec.target_group_name.slice(0, 17) + "..." : rec.target_group_name,
              imageUrl: rec.target_group_image_url || "https://res.cloudinary.com/dg5qvbxjp/image/upload/v1760466568/base_s5smwn.png",
              style: "primary" as const,
            }],
          });

          await RecommendationAdapter.markSent(rec.id);
          logger.info(`✅ Outbox: sent recommendation "${rec.target_group_name}" to ${rec.sender_inbox_id.slice(0, 12)}...`);
        } catch (err: any) {
          logger.error(`❌ Outbox: failed to send rec ${rec.id}: ${err.message}`);
          await RecommendationAdapter.markFailed(rec.id);
        }
      } catch (err: any) {
        logger.error(`❌ Outbox drain error: ${err.message}`);
      } finally {
        this.isOutboxDraining = false;
      }
    }, DRAIN_INTERVAL);
  }

  async stop(): Promise<void> {
    logger.info("🛑 Shutting down XMTP Base...");
    
    
    await this.registry.shutdownAll();
    process.exit(0);
  }

  getAgent(): Agent {
    if (!this.agent) throw new Error("Agent not initialized");
    return this.agent;
  }

  getClient(): Client<any> {
    if (!this.client) throw new Error("Client not initialized");
    return this.client;
  }

  private setupMiddleware(): void {
    if (!this.agent) {
      throw new Error("XMTP Base not initialized. Call init() first.");
    }

    this.agent.use(loggingMiddleware);
    this.agent.use(groupMessageFilterMiddleware);

    this.registerActionHandlers();
    this.agent.use(inlineActionsMiddleware);
  }

  private registerActionHandlers(): void {
    const plugins = this.registry.getPlugins();
    let totalActions = 0;

    for (const plugin of plugins) {
      const actionsMap = plugin.getActions?.();
      if (!actionsMap) continue;

      for (const [actionId, handler] of actionsMap.entries()) {
        const wrappedHandler: ActionHandler = async (ctx) => {
          logger.info(
            {
              action: actionId,
              plugin: plugin.metadata.name,
              sender: ctx.message.senderInboxId.substring(0, 8),
            },
            `Action: ${actionId}`,
          );
          await handler(ctx);
        };
        registerAction(actionId, wrappedHandler);
        totalActions++;
      }

      logger.info(
        { plugin: plugin.metadata.name, count: actionsMap.size },
        `Registered ${actionsMap.size} action(s) from ${plugin.metadata.name}`,
      );
    }

    if (totalActions > 0) {
      logger.info(`📱 Total inline actions registered: ${totalActions}`);
    }
  }

  private async dispatchToPlugins<T>(
    eventName: string,
    plugins: readonly XMTPServicePlugin[],
    handler: (plugin: XMTPServicePlugin) => ((ctx: T) => Promise<boolean | void>) | undefined,
    ctx: T,
  ) {
    for (const plugin of plugins) {
      const fn = handler(plugin);
      if (!fn) continue;

      const handled = await fn(ctx);
      if (handled) {
        logger.info(
          { event: eventName, plugin: plugin.metadata.name },
          `Handled by: ${plugin.metadata.name}`,
        );
        break;
      }
    }
  }

  private agentStreamOptions() {
    return {
      retryDelay: 5_000,
      retryAttempts: 60,
      onRetry: (attempts: number, maxAttempts: number) => {
        logger.warn(`⚠️ XMTP stream retry ${attempts}/${maxAttempts}`);
      },
      onRestart: () => {
        logger.info("🔁 XMTP stream restarted (node-sdk)");
      },
      onFail: () => {
        logger.warn("⚠️ XMTP stream dropped; retrying (node-sdk)");
      },
      onEnd: () => {
        logger.warn("⚠️ XMTP stream ended (node-sdk)");
      },
    };
  }

  private async startAgentStreams(): Promise<void> {
    if (!this.agent) throw new Error("Agent not initialized");
    await this.agent.start(this.agentStreamOptions());
  }

  /**
   * agent-sdk calls stop() when the error middleware chain does not recover.
   * That leaves the HTTP API up but silently drops all DMs — easy to miss in logs.
   */
  private setupStreamRecovery(): void {
    if (!this.agent) return;

    this.agent.errors.use(async (error, _ctx, next) => {
      const message = error instanceof Error ? error.message : String(error);

      if (error instanceof AgentError && error.code === 1003) {
        logger.warn(
          { err: message },
          "XMTP message for unknown conversation — syncing conversations and keeping stream alive",
        );
        try {
          await this.client?.conversations.sync();
        } catch (syncErr: any) {
          logger.warn(`⚠️ conversations.sync() after 1003 failed: ${syncErr?.message || syncErr}`);
        }
        next();
        return;
      }

      if (error instanceof AgentStreamingError) {
        logger.warn({ err: message }, "XMTP streaming error recovered (stream kept alive)");
        next();
      }
    });

    this.agent.on("stop", () => {
      logger.error(
        "🛑 XMTP Agent message stream stopped — DMs will not be processed until streams restart",
      );
      this.scheduleStreamRestart();
    });

    this.agent.on("unhandledError", (error: Error) => {
      logger.error({ err: error }, "XMTP unhandled error — scheduling stream restart");
      this.scheduleStreamRestart();
    });
  }

  private scheduleStreamRestart(): void {
    if (this.streamRestartScheduled || !this.agent) return;
    this.streamRestartScheduled = true;

    setTimeout(() => {
      this.streamRestartScheduled = false;
      if (!this.agent) return;

      void this.startAgentStreams()
        .then(() => logger.info("✅ XMTP Agent streams restarted after stop"))
        .catch((err: any) => {
          logger.error(
            { err: err?.message || err },
            "❌ Failed to restart XMTP Agent streams — restart the basemate-tba process",
          );
        });
    }, 3_000);
  }

  private runEventHandler(eventName: string, fn: () => Promise<void>): void {
    void fn().catch((err: any) => {
      logger.error(`❌ XMTP ${eventName} handler failed: ${err?.message || err}`);
    });
  }

  private shouldIgnoreMessage(ctx: MessageContext): boolean {
    if (filter.isText(ctx.message)) return true;
    if (filter.isReaction(ctx.message)) return true;
    if (filter.isReply?.(ctx.message)) return true;
    if (filter.usesCodec(ctx.message, IntentCodec)) return true;
    return false;
  }

  private handleCallbacks(): void {
    if (!this.agent) throw new Error("Agent not initialized");
    logger.info("🔗 Setting up event dispatcher...");

    const plugins = this.registry.getSortedPlugins();

    this.agent.on("reaction", (ctx) => {
      this.runEventHandler("reaction", async () => {
        logger.info("👍 Event: reaction");
        await this.dispatchToPlugins("reaction", plugins, (p) => p.onReaction, ctx);
      });
    });

    this.agent.on("dm", (ctx) => {
      this.runEventHandler("dm", async () => {
        logger.info("📨 Event: dm");
        await this.dispatchToPlugins("dm", plugins, (p) => p.onDm, ctx);
      });
    });

    this.agent.on("group", (ctx) => {
      this.runEventHandler("group", async () => {
        logger.info("👥 Event: group");
        await this.dispatchToPlugins("group", plugins, (p) => p.onGroup, ctx);
      });
    });

    this.agent.on("group-update", (ctx) => {
      this.runEventHandler("group-update", async () => {
        logger.info("🔄 Event: group-update");
        await this.dispatchToPlugins("group-update", plugins, (p) => p.onGroupUpdate, ctx);
      });
    });

    this.agent.on("text", (ctx) => {
      this.runEventHandler("text", async () => {
        if (!filter.fromSelf(ctx.message, ctx.client)) {
          const content =
            typeof ctx.message.content === "string" ? ctx.message.content : "";
          const inGroup = filter.isGroup(ctx.conversation);
          if (!inGroup || (await shouldEngageInGroup(ctx, content))) {
            try {
              await sendReaction(ctx);
            } catch (err: any) {
              logger.warn(`⚠️ sendReaction failed: ${err?.message || err}`);
            }
          }
        }
        await this.dispatchToPlugins("text", plugins, (p) => p.onText, ctx);
      });
    });

    this.agent.on("reply", (ctx) => {
      this.runEventHandler("reply", async () => {
        logger.info("↩️ Event: reply");
        if (!filter.fromSelf(ctx.message, ctx.client)) {
          const inGroup = filter.isGroup(ctx.conversation);
          const replyText = extractReplyText(ctx);
          if (!inGroup || (await shouldEngageInGroup(ctx, replyText))) {
            try {
              await sendReaction(ctx as unknown as MessageContext<string>);
            } catch (err: any) {
              logger.warn(`⚠️ sendReaction failed: ${err?.message || err}`);
            }
          }
        }
        await this.dispatchToPlugins("reply", plugins, (p) => p.onReply, ctx);
      });
    });

    this.agent.on("attachment", (ctx) => {
      this.runEventHandler("attachment", async () => {
        logger.info("📎 Event: attachment");
        await this.dispatchToPlugins("attachment", plugins, (p) => p.onAttachment, ctx);
      });
    });

    this.agent.on("message", (ctx) => {
      if (this.shouldIgnoreMessage(ctx)) return;
      this.runEventHandler("message", async () => {
        logger.info("📩 Event: message");
        await this.dispatchToPlugins("message", plugins, (p) => p.onMessage, ctx);
      });
    });
  }
}
