/**
 * Print this group's Alexander pot addresses (owner EOA + smart account).
 *
 * Usage:
 *   bun packages/core/src/swear-jar/print-house-address.ts '<group-conversation-id>'
 */
import { getOrCreateGroupPot } from "./pot.js";
import { potAccountNameForConversation } from "./constants.js";

const conversationId = process.argv[2]?.trim();
if (!conversationId) {
  console.error("usage: bun packages/core/src/swear-jar/print-house-address.ts '<conversationId>'");
  process.exit(1);
}

const pot = await getOrCreateGroupPot(conversationId);
console.log(`conversation: ${conversationId}`);
console.log(`owner account: ${potAccountNameForConversation(conversationId)}`);
console.log(`owner EOA: ${pot.ownerAddress}`);
console.log(`pot (smart account, receives fines): ${pot.address}`);
