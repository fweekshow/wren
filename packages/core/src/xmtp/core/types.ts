import { Agent, Client, MessageContext } from "@xmtp/agent-sdk";

export type CommandHandler = (ctx: MessageContext<string>) => Promise<void>;
export type ActionHandler = (ctx: MessageContext<unknown>) => Promise<void>;
export type EventResult = boolean | void;

export interface CommandEntry {
  name: string;
  handler: CommandHandler;
}

export interface ActionEntry {
  id: string;
  handler: ActionHandler;
}

export interface PluginMetadata {
  name: string;
  version?: string;
  priority: number; // 1-100 (1 = highest priority)
  description?: string;
}

export abstract class XMTPServicePlugin {
  abstract metadata: PluginMetadata;

  client?: Client<any>;
  agent?: Agent;

  setContext(client: Client<any>, agent: Agent) {
    this.client = client;
    this.agent = agent;
  }

  // Lifecycle hooks
  async onInit?(): Promise<void>;
  async onShutdown?(): Promise<void>;

  // Simple commands (registered to CommandRouter)
  getCommands?(): Map<string, CommandHandler>;

  // Inline actions (registered to inline-actions middleware)
  getActions?(): Map<string, ActionHandler>;

  // Event handlers called by XMTPBase dispatcher
  onText?(ctx: MessageContext<string>): Promise<EventResult>;
  onReply?(ctx: MessageContext<any>): Promise<EventResult>;
  onReaction?(ctx: any): Promise<EventResult>;
  onDm?(ctx: any): Promise<EventResult>;
  onGroup?(ctx: any): Promise<EventResult>;
  onGroupUpdate?(ctx: any): Promise<EventResult>;
  onMessage?(ctx: any): Promise<EventResult>;
  onAttachment?(ctx: MessageContext<unknown>): Promise<EventResult>;
}
