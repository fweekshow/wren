import {
  type AgentMiddleware,
  type Conversation,
  filter,
  type MessageContext,
} from "@xmtp/agent-sdk";


import { type Action, type ActionsContent, ContentTypeActions } from "./types/ActionsContent.js";
import { type IntentContent } from "./types/IntentContent.js";

// Core types
export type ActionHandler<T = unknown> = (ctx: MessageContext<T>) => Promise<void>;

// Action registry - using unknown to accept handlers for any content type
const actionHandlers = new Map<string, ActionHandler<unknown>>();

// Track the last sent action message for reply functionality
let lastSentActionMessage: unknown = null;

// Track the last shown menu for automatic navigation
let lastShownMenu: { config: AppConfig; menuId: string } | null = null;

export function registerAction<T = unknown>(
  actionId: string,
  handler: ActionHandler<T> | ((ctx: any) => Promise<void>),
): void {
  // Prevent overwriting existing handlers unless explicitly intended
  if (actionHandlers.has(actionId)) {
    console.warn(`⚠️ Action ${actionId} already registered, overwriting...`);
  }
  actionHandlers.set(actionId, handler as ActionHandler<unknown>);
}

/** Register only if absent — used during menu bootstrap to avoid duplicate nav ids. */
function registerActionOnce<T = unknown>(
  actionId: string,
  handler: ActionHandler<T> | ((ctx: any) => Promise<void>),
): boolean {
  if (actionHandlers.has(actionId)) return false;
  actionHandlers.set(actionId, handler as ActionHandler<unknown>);
  return true;
}

// Get the last sent action message for reply functionality
export function getLastSentActionMessage(): unknown {
  return lastSentActionMessage;
}

// Clear all registered actions (useful for debugging)
export function clearAllActions(): void {
  actionHandlers.clear();
  console.log("🧹 Cleared all registered actions");
}

// Show the last shown menu
export async function showLastMenu<T = unknown>(ctx: MessageContext<T>): Promise<void> {
  if (lastShownMenu) {
    console.log(`🔄 Showing last menu: ${lastShownMenu.menuId}`);
    await showMenu(ctx, lastShownMenu.config, lastShownMenu.menuId);
  } else {
    console.warn("⚠️ No last menu to show, falling back to main menu");
    // Fallback to main menu if no last menu is tracked
    await ctx.sendText("Returning to main menu...");
  }
}

/**
 * Extracts the numeric match ID from a world-cup action ID, or returns null
 * if the action doesn't match any known WC pattern.
 * e.g. "wc_bet_home_1567311" → "1567311"
 *      "wc_stake_100_1567311_home" → "1567311"
 */
function extractWcMatchId(actionId: string): string | null {
  const patterns = [
    /^wc_bet_(?:home|away|draw)_(\d+)$/,
    /^wc_stake_\d+_(\d+)_/,
    /^wc_usd_\d+_(\d+)_/,
    /^wc_match_(\d+)$/,
  ];
  for (const re of patterns) {
    const m = actionId.match(re);
    if (m) return m[1];
  }
  return null;
}

// Middleware - works with any content type
// Using any for the context parameter to allow compatibility with any agent content types
function stripAgentPrefix(actionId: string): string {
  if (actionId.length > 9 && actionId.charAt(8) === "_") {
    const first8 = actionId.substring(0, 8);
    if (/^[0-9a-f]{8}$/i.test(first8)) return actionId.substring(9);
  }
  return actionId;
}

export const inlineActionsMiddleware = (async (ctx: any, next: () => Promise<void>) => {
  if (ctx.message.contentType?.typeId === "intent") {
    const intentContent = ctx.message.content as IntentContent;
    const baseActionId = stripAgentPrefix(intentContent.actionId);

    console.log("🎯 Processing intent:", baseActionId);

    const senderInboxId = ctx.message?.senderInboxId as string | undefined;
    if (senderInboxId) {
      import("@/discovery/adapters/user.adapter.js")
        .then(({ UserAdapter }) => UserAdapter.recordButtonClick(senderInboxId, baseActionId))
        .catch(() => {});
    }

    let handler = actionHandlers.get(baseActionId) || actionHandlers.get(intentContent.actionId);

    if (!handler) {
      for (const [pattern, h] of actionHandlers.entries()) {
        if (pattern.endsWith("*") && baseActionId.startsWith(pattern.slice(0, -1))) {
          handler = h;
          break;
        }
      }
    }

    if (handler) {
      try {
        (ctx as any).__baseActionId = baseActionId;
        await handler(ctx as MessageContext<unknown>);
      } catch (error) {
        console.error(`❌ Error in action handler:`, error);
      }
    } else {
      console.log(`⚠️ Unknown action: ${baseActionId}`);
      // Action was registered in a previous server session — try smart recovery
      // for known prefixes, otherwise tell the user to retry.
      try {
        const wcMatchId = extractWcMatchId(baseActionId);
        if (wcMatchId) {
          // Re-render the match card so the user can tap fresh buttons.
          const { getWorldCupRenderer } = await import(
            "@/xmtp/plugins/worldCup.plugin.js"
          );
          const wc = getWorldCupRenderer();
          if (wc) {
            await (wc as any).renderMatchCards(
              ctx as MessageContext<unknown>,
              await (await import("@/worldcup/service.js")).searchEnrichedMatches({ matchId: wcMatchId }),
            );
          } else {
            await (ctx as MessageContext<unknown>).conversation.send(
              "that button expired — ask me for World Cup matches to get fresh ones",
            );
          }
        } else {
          await (ctx as MessageContext<unknown>).conversation.send(
            "that button expired when the server restarted — just tap the menu again and it'll work 💙",
          );
        }
      } catch {
        // best-effort
      }
    }
    return;
  }
  await next();
}) as AgentMiddleware as any;

// Builder for creating actions
export class ActionBuilder {
  private actions: Action[] = [];
  private actionId = "";
  private actionDescription = "";

  static create(id: string, description: string): ActionBuilder {
    const builder = new ActionBuilder();
    builder.actionId = id;
    builder.actionDescription = description;
    return builder;
  }

  add(id: string, label: string, style?: "primary" | "secondary" | "danger"): this {
    this.actions.push({ id, label, style });
    return this;
  }

  build(): ActionsContent {
    return {
      id: this.actionId,
      description: this.actionDescription,
      actions: this.actions,
    };
  }

  async send<T = unknown>(ctx: MessageContext<T>): Promise<void> {
    const message = await ctx.conversation.send(this.build(), ContentTypeActions);
    lastSentActionMessage = message;
  }
}

// Helper functions
export async function sendActions(
  conversation: Conversation,
  actionsContent: ActionsContent,
): Promise<void> {
  const message = await conversation.send(actionsContent, ContentTypeActions);
  lastSentActionMessage = message;
}

export async function sendConfirmation<T = unknown>(
  ctx: MessageContext<T> | any,
  message: string,
  onYes: ActionHandler<T> | ((ctx: any) => Promise<void>),
  onNo?: ActionHandler<T> | ((ctx: any) => Promise<void>),
): Promise<void> {
  const timestamp = Date.now();
  const yesId = `yes-${timestamp}`;
  const noId = `no-${timestamp}`;

  registerAction(yesId, onYes as ActionHandler<unknown>);
  registerAction(
    noId,
    (onNo ||
      (async (ctx) => {
        await ctx.sendText("❌ Cancelled");
      })) as ActionHandler<unknown>,
  );

  await ActionBuilder.create(`confirm-${timestamp}`, message)
    .add(yesId, "✅ Yes")
    .add(noId, "❌ No", "danger")
    .send(ctx);
}

export async function sendSelection<T = unknown>(
  ctx: MessageContext<T>,
  message: string,
  options: Array<{
    id: string;
    label: string;
    style?: "primary" | "secondary" | "danger";
    handler: ActionHandler<T>;
  }>,
): Promise<void> {
  const builder = ActionBuilder.create(`selection-${Date.now()}`, message);

  options.forEach((option) => {
    registerAction(option.id, option.handler);
    builder.add(option.id, option.label, option.style);
  });

  await builder.send(ctx);
}

// Validation helpers
export const validators = {
  inboxId: (input: string) => {
    const pattern = /^[a-fA-F0-9]{64}$/;
    return pattern.test(input.trim())
      ? { valid: true }
      : { valid: false, error: "Invalid Inbox ID format (64 hex chars)" };
  },

  ethereumAddress: (input: string) => {
    const pattern = /^0x[a-fA-F0-9]{40}$/;
    return pattern.test(input.trim())
      ? { valid: true }
      : {
          valid: false,
          error: "Invalid Ethereum address format (0x + 40 hex chars)",
        };
  },
};

// Common patterns
export const patterns = {
  inboxId: /^[a-fA-F0-9]{64}$/,
  ethereumAddress: /^0x[a-fA-F0-9]{40}$/,
};

// Additional types needed by index.ts
export type MenuAction<T = unknown> = {
  id: string;
  label: string;
  style?: "primary" | "secondary" | "danger";
  handler?: ActionHandler<T>;
  showNavigationOptions?: boolean;
  /** Hidden from inline menus in group chats — handler may still redirect to DM. */
  dmOnly?: boolean;
};

export type Menu = {
  id: string;
  title: string;
  actions: MenuAction[];
  /** Entire submenu hidden in group chats (navigation + actions). */
  dmOnly?: boolean;
};

export type AppConfig = {
  name: string;
  menus: Record<string, Menu>;
  options?: {
    autoShowMenuAfterAction?: boolean;
    defaultNavigationMessage?: string;
  };
};

// Utility functions needed by index.ts
export function getRegisteredActions(): string[] {
  return Array.from(actionHandlers.keys());
}

export async function showMenu<T = unknown>(
  ctx: MessageContext<T>,
  config: AppConfig,
  menuId: string,
  descriptionOverride?: string,
): Promise<void> {
  const menu = config.menus[menuId];
  if (!menu) {
    console.error(`❌ Menu not found: ${menuId}`);
    await ctx.sendText(`❌ Menu not found: ${menuId}`);
    return;
  }

  const inGroup = filter.isGroup(ctx.conversation);
  if (inGroup && menu.dmOnly) {
    await ctx.sendText(
      "perps run in our dm — check your messages with me.",
    );
    return;
  }

  // Track the last shown menu
  lastShownMenu = { config, menuId };

  const builder = ActionBuilder.create(menuId, descriptionOverride ?? menu.title);

  menu.actions.forEach((action) => {
    if (inGroup && action.dmOnly) return;
    builder.add(action.id, action.label, action.style);
  });

  await builder.send(ctx);
}

// Configurable navigation helper
export async function showNavigationOptions<T = unknown>(
  ctx: MessageContext<T>,
  config: AppConfig,
  message: string,
  customActions?: Array<{
    id: string;
    label: string;
    style?: "primary" | "secondary" | "danger";
  }>,
): Promise<void> {
  // Check if auto-show menu is enabled (default: true for backward compatibility)
  const autoShowMenu = config.options?.autoShowMenuAfterAction !== false;

  if (!autoShowMenu) {
    // If auto-show is disabled, just send the message without showing menu
    await ctx.sendText(message);
    return;
  }

  // Use a stable action ID to prevent conflicts
  const navigationMenu = ActionBuilder.create("navigation-options", message);

  // Add custom actions if provided
  if (customActions) {
    customActions.forEach((action) => {
      navigationMenu.add(action.id, action.label, action.style);
    });
  } else {
    // Default navigation options - show all main menu items
    const mainMenu = config.menus["main-menu"];
    const inGroup = filter.isGroup(ctx.conversation);
    if (mainMenu) {
      mainMenu.actions.forEach((action) => {
        if (inGroup && action.dmOnly) return;
        navigationMenu.add(action.id, action.label, action.style);
      });
    }
  }

  await navigationMenu.send(ctx);
}

export function initializeAppFromConfig(
  config: AppConfig,
  options?: {
    deferredHandlers?: Record<string, ActionHandler>;
  },
): void {
  console.log(`🚀 Initializing app: ${config.name}`);

  // Log configuration options
  if (config.options) {
    console.log(`📋 App options:`, config.options);
  }

  // Register all handlers from menu actions
  Object.values(config.menus).forEach((menu) => {
    menu.actions.forEach((action) => {
      if (action.handler) {
        // Wrap handler to automatically show last menu if showNavigationOptions is true
        const wrappedHandler = async (ctx: MessageContext<unknown>) => {
          await action.handler?.(ctx);
          if (action.showNavigationOptions) {
            await showLastMenu(ctx);
          }
        };
        registerAction(action.id, wrappedHandler);
        console.log(
          `✅ Registered handler for action: ${action.id}${action.showNavigationOptions ? " (with auto-navigation)" : ""}`,
        );
      }
    });
  });

  // Register any deferred handlers
  if (options?.deferredHandlers) {
    Object.entries(options.deferredHandlers).forEach(([actionId, handler]) => {
      registerAction(actionId, handler);
      console.log(`✅ Registered deferred handler for action: ${actionId}`);
    });
  }

  const showMenuById = (menuId: string) => async (ctx: MessageContext<unknown>) => {
    await showMenu(ctx, config, menuId);
  };

  // Common back/help targets — register once before submenu BACK buttons (same ids).
  for (const id of ["main-menu", "help", "back-to-main"] as const) {
    if (registerActionOnce(id, showMenuById("main-menu"))) {
      console.log(`✅ Registered navigation: ${id}`);
    }
  }

  // Auto-register menu navigation (e.g. main-menu → menu_swap; submenu BACK → main-menu).
  Object.values(config.menus).forEach((menu) => {
    menu.actions.forEach((action) => {
      if (!action.handler && config.menus[action.id]) {
        if (registerActionOnce(action.id, showMenuById(action.id))) {
          console.log(`✅ Auto-registered navigation for menu: ${action.id}`);
        }
      }
    });
  });
}
