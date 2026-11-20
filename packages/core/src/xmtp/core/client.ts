import fs from "node:fs";
import dns from "node:dns/promises";
import tls from "node:tls";

import { Agent } from "@xmtp/agent-sdk";
import { Client } from "@xmtp/node-sdk";
import { MarkdownCodec } from "@xmtp/content-type-markdown";
import { ReactionCodec } from "@xmtp/content-type-reaction";
import { WalletSendCallsCodec } from "@xmtp/content-type-wallet-send-calls";
import { AttachmentCodec, RemoteAttachmentCodec } from "@xmtp/content-type-remote-attachment";

import { config } from "@/config/config.js";
import { logger } from "@/utils/logger.js";
import { ActionsCodec, IntentCodec } from "@/xmtp/content-types/inline-actions/types/index.js";

export class XMTPClient {
  async createAgent(): Promise<Agent> {
    const dbName = process.env.XMTP_DB_NAME?.trim() || "basemate-v2";
    const dbPath = this.getDbPath(dbName);
    const env = config.xmtp.env as "dev" | "production";

    logger.info(`\x1b[38;2;252;76;52m
            ██╗  ██╗███╗   ███╗████████╗██████╗ 
            ╚██╗██╔╝████╗ ████║╚══██╔══╝██╔══██╗
             ╚███╔╝ ██╔████╔██║   ██║   ██████╔╝
             ██╔██╗ ██║╚██╔╝██║   ██║   ██╔═══╝ 
            ██╔╝ ██╗██║ ╚═╝ ██║   ██║   ██║     
            ╚═╝  ╚═╝╚═╝     ╚═╝   ╚═╝   ╚═╝     
          \x1b[0m`);
    logger.info(`🔧 Creating XMTP Agent (env: ${env}, db: ${dbPath})`);

    process.env.XMTP_ENV ??= env;
    process.env.XMTP_WALLET_KEY ??= config.xmtp.walletKey;
    process.env.XMTP_DB_ENCRYPTION_KEY ??= config.xmtp.dbEncryptionKey;
    // Agent SDK uses XMTP_DB_DIRECTORY (dir); we pass an explicit db file via dbPath.
    delete process.env.XMTP_DB_DIRECTORY;

    this.stripProxyEnvForGrpc();
    this.logDeployIdentity();
    this.logRuntimeDiagnostics();
    await this.logNetworkPreflight(env);
    const grpcOk = await this.logGrpcPreflight(env);
    if (!grpcOk) {
      throw new Error(
        "XMTP gRPC preflight failed — outbound calls to grpc.production.xmtp.network are blocked or degraded. " +
          "Try a US Railway region, remove HTTP(S)_PROXY vars, or check Railway networking status.",
      );
    }

    const codecs = [
      new ActionsCodec(),
      new IntentCodec(),
      new ReactionCodec(),
      new MarkdownCodec(),
      new WalletSendCallsCodec(),
      new AttachmentCodec(),
      new RemoteAttachmentCodec(),
    ];

    const createAttempts = 3;
    let lastErr: unknown;
    let agent: Agent | undefined;

    for (let attempt = 1; attempt <= createAttempts; attempt++) {
      try {
        agent = await Agent.createFromEnv({
          env: env,
          dbPath,
          codecs: codecs as never,
        });
        lastErr = undefined;
        break;
      } catch (err: unknown) {
        lastErr = err;
        const serialized = this.serializeError(err);
        const retryable =
          serialized.message?.includes("transport error") ||
          serialized.code === "GenericFailure";
        logger.error(
          {
            env,
            dbPath,
            attempt,
            createAttempts,
            runtime: process.release?.name ?? "unknown",
            hasXmtpWalletKey: Boolean(process.env.XMTP_WALLET_KEY),
            hasXmtpDbEncryptionKey: Boolean(process.env.XMTP_DB_ENCRYPTION_KEY),
            error: serialized,
          },
          retryable && attempt < createAttempts
            ? "⚠️ XMTP Agent creation failed (will retry)"
            : "❌ XMTP Agent creation failed",
        );
        if (process.env.XMTP_FORCE_DEBUG === "true" || process.env.XMTP_FORCE_DEBUG === "1") {
          logger.info("XMTP_FORCE_DEBUG is on — libxmtp will emit verbose logs on next attempt");
        }
        if (!retryable || attempt >= createAttempts) {
          if (retryable && attempt >= createAttempts) {
            await this.logEphemeralDbProbe(env, dbPath, codecs);
          }
          break;
        }
        await new Promise((r) => setTimeout(r, 2_000 * attempt));
      }
    }

    if (!agent) {
      const runtime = process.release?.name ?? "unknown";
      if (runtime === "node") {
        logger.error(
          "XMTP still failing on Node — set XMTP_FORCE_DEBUG=true, confirm the volume mount " +
            "(RAILWAY_VOLUME_MOUNT_PATH or XMTP_VOLUME_MOUNT_PATH, e.g. /app/data), and try a " +
            "US deploy region if Southeast Asia networking is degraded.",
        );
      } else {
        logger.error(
          `XMTP native gRPC is unreliable under ${runtime}. ` +
            "Run basemate-tba with Node 22 in production (see apps/basemate-tba/Dockerfile).",
        );
      }
      throw lastErr;
    }
    logger.info(`✅ XMTP Agent created`);
    logger.info(` Address: ${agent.address}`);
    logger.info(`Inbox ID: ${agent.client.inboxId}`);

    return agent;
  }

  private getDbPath(description: string = "xmtp"): string {
    const volumePath = config.xmtp.volumeMountPath;
    if (!fs.existsSync(volumePath)) fs.mkdirSync(volumePath, { recursive: true });
    return `${volumePath}/${description}.db3`;
  }

  private logDeployIdentity(): void {
    logger.info(
      {
        railwayGitCommit: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 12),
        railwayDeploymentId: process.env.RAILWAY_DEPLOYMENT_ID,
        railwayService: process.env.RAILWAY_SERVICE_NAME,
        railwayEnvironment: process.env.RAILWAY_ENVIRONMENT_NAME,
      },
      "XMTP deploy identity (compare to GitHub commit on feat/perp-mate-tier-flow or main)",
    );
  }

  /** Proxy env vars break native HTTP/2 gRPC in @xmtp/node-bindings on some PaaS hosts. */
  private stripProxyEnvForGrpc(): void {
    const keys = [
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "http_proxy",
      "https_proxy",
      "ALL_PROXY",
      "all_proxy",
    ] as const;
    for (const key of keys) {
      if (process.env[key]) {
        logger.warn({ key }, "Unsetting proxy env var before XMTP gRPC");
        delete process.env[key];
      }
    }
  }

  private logRuntimeDiagnostics(): void {
    logger.info(
      {
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        volumeMountPath: config.xmtp.volumeMountPath,
        dbFileExists: fs.existsSync(
          `${config.xmtp.volumeMountPath}/${process.env.XMTP_DB_NAME?.trim() || "basemate-v2"}.db3`,
        ),
        httpProxy: Boolean(process.env.HTTP_PROXY || process.env.http_proxy),
        httpsProxy: Boolean(process.env.HTTPS_PROXY || process.env.https_proxy),
      },
      "XMTP runtime diagnostics",
    );
  }

  /** Exercises libxmtp gRPC (no local DB) — distinguishes network vs Agent.create issues. */
  private async logGrpcPreflight(env: "dev" | "production"): Promise<boolean> {
    try {
      await Client.canMessage([], env);
      logger.info({ env }, "✅ XMTP gRPC canMessage preflight passed");
      return true;
    } catch (err: unknown) {
      logger.error(
        { env, error: this.serializeError(err) },
        "❌ XMTP gRPC canMessage preflight failed (Agent.create will likely fail too)",
      );
      return false;
    }
  }

  /** If gRPC works but volume DB fails, logs whether a fresh temp DB can connect. */
  private async logEphemeralDbProbe(
    env: "dev" | "production",
    volumeDbPath: string,
    codecs: unknown[],
  ): Promise<void> {
    const probePath = `/tmp/xmtp-probe-${Date.now()}.db3`;
    try {
      const probe = await Agent.createFromEnv({ env, dbPath: probePath, codecs: codecs as never });
      logger.warn(
        {
          volumeDbPath,
          probePath,
          probeInboxId: probe.client.inboxId,
        },
        "XMTP Agent.create succeeded on ephemeral DB only — volume DB may be corrupt or " +
          "XMTP_DB_ENCRYPTION_KEY may not match the file on the Railway volume. " +
          "Rename basemate-v2.db3 on the volume or restore the original encryption key.",
      );
      try {
        fs.unlinkSync(probePath);
      } catch {
        /* ignore */
      }
    } catch (err: unknown) {
      logger.error(
        { volumeDbPath, probePath, error: this.serializeError(err) },
        "XMTP ephemeral DB probe also failed — likely outbound gRPC/network, not the volume file",
      );
    }
  }

  private async logNetworkPreflight(env: "dev" | "production"): Promise<void> {
    const host =
      env === "production" ? "grpc.production.xmtp.network" : "grpc.dev.xmtp.network";
    const port = 443;

    try {
      const addresses = await dns.lookup(host, { all: true });
      const tlsInfo = await this.checkTls(host, port);
      logger.info(
        {
          host,
          port,
          addressCount: addresses.length,
          authorized: tlsInfo.authorized,
          protocol: tlsInfo.protocol,
          alpnProtocol: tlsInfo.alpnProtocol,
        },
        "✅ XMTP network preflight passed",
      );
    } catch (err: any) {
      logger.warn(
        {
          host,
          port,
          error: this.serializeError(err),
        },
        "⚠️ XMTP network preflight failed",
      );
    }
  }

  private checkTls(
    host: string,
    port: number,
  ): Promise<{ authorized: boolean; protocol: string | null; alpnProtocol: string | false }> {
    return new Promise((resolve, reject) => {
      const socket = tls.connect({ host, port, servername: host, ALPNProtocols: ["h2"] });
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error("TLS preflight timed out"));
      }, 5_000);

      socket.once("secureConnect", () => {
        clearTimeout(timeout);
        const result = {
          authorized: socket.authorized,
          protocol: socket.getProtocol(),
          alpnProtocol: socket.alpnProtocol ?? false,
        };
        socket.end();
        resolve(result);
      });

      socket.once("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  private serializeError(err: any) {
    return {
      name: err?.name,
      message: err?.message || String(err),
      code: err?.code,
      cause: err?.cause
        ? {
            name: err.cause.name,
            message: err.cause.message || String(err.cause),
            code: err.cause.code,
          }
        : undefined,
      stack: err?.stack,
    };
  }
}
