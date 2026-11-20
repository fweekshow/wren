import { Agent, Client } from "@xmtp/agent-sdk";

import { logger } from "@/utils/logger.js";

import { XMTPServicePlugin } from "./types.js";

export class ServiceRegistry {
  private plugins: XMTPServicePlugin[] = [];

  register(plugin: XMTPServicePlugin): void {
    this.plugins.push(plugin);
    logger.info(
      `📦 Registered plugin: ${plugin.metadata.name} (priority: ${plugin.metadata.priority})`,
    );
  }

  async initializeAll(client: Client<any>, agent: Agent): Promise<void> {
    logger.info("\n🔄 Initializing plugins...");
    const sorted = this.getSortedPlugins();

    for (const plugin of sorted) {
      await plugin.setContext(client, agent);
      try {
        await plugin.onInit?.();
        logger.info(`✅ ${plugin.metadata.name} initialized`);
      } catch (err) {
        logger.error(
          { err },
          `❌ ${plugin.metadata.name} onInit failed — plugin disabled for this session`,
        );
      }
    }
  }

  async shutdownAll(): Promise<void> {
    logger.info("🛑 Shutting down plugins...");

    for (const plugin of this.plugins) {
      await plugin.onShutdown?.();
    }
  }

  getSortedPlugins(): XMTPServicePlugin[] {
    return [...this.plugins].sort((a, b) => a.metadata.priority - b.metadata.priority);
  }

  getPlugins(): XMTPServicePlugin[] {
    return this.plugins;
  }

  getPlugin(name: string): XMTPServicePlugin | undefined {
    return this.plugins.find((p) => p.metadata.name === name);
  }
}
