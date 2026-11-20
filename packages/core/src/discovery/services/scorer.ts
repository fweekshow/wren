import { createBankrLlmClient, DEFAULT_CHAT_MODEL, openAiChatParams } from "@/llm/config.js";
import { NSGroupAdapter } from "@/discovery/adapters/nsGroup.adapter.js";
import { RecommendationAdapter } from "@/discovery/adapters/recommendation.adapter.js";

const DEFAULT_IMAGE = "https://res.cloudinary.com/dg5qvbxjp/image/upload/v1760466568/base_s5smwn.png";
const SCORE_THRESHOLD = 75;
const MIN_MESSAGE_LENGTH = 8;

interface GroupCandidate {
  groupId: string;
  name: string;
  description: string;
  tags: string[];
  score: number;
  imageUrl: string;
}

interface ScorerResult {
  score: number;
  reasoning: string;
  detected_interests: string[];
  suggested_community_id: string | null;
}

interface ScoreMessageParams {
  messageContent: string;
  senderInboxId: string;
  senderWalletAddress: string | null;
  sourceGroupId: string;
}

async function fetchSuggestableGroups(): Promise<GroupCandidate[]> {
  const groups = await NSGroupAdapter.getSuggestableGroups();
  return groups
    .map((g) => ({
      groupId: g.group_id,
      name: g.name,
      description: g.description || "",
      tags: Array.isArray(g.tags) ? g.tags : [],
      score: g.total_messages ?? 0,
      imageUrl: g.image_url || DEFAULT_IMAGE,
    }))
    .sort((a, b) => b.score - a.score);
}

function activityLabel(score: number): string {
  if (score > 10) return " (popular)";
  if (score > 0) return " (active)";
  return "";
}

function buildGroupList(groups: GroupCandidate[], sourceGroupId: string): string {
  return groups
    .filter((g) => g.groupId !== sourceGroupId)
    .map((g, i) => {
      const tags = g.tags.slice(0, 8).join(", ");
      const desc = g.description ? ` — ${g.description.slice(0, 80)}` : "";
      return `${i + 1}. [ID: ${g.groupId}] "${g.name}"${activityLabel(g.score)}${desc} [${tags}]`;
    })
    .join("\n");
}

const openai = (() => {
  try {
    return createBankrLlmClient();
  } catch {
    return null;
  }
})();

export async function scoreMessage(params: ScoreMessageParams): Promise<void> {
  const { messageContent, senderInboxId, senderWalletAddress, sourceGroupId } = params;

  if (!openai) return;
  if (!messageContent || messageContent.length < MIN_MESSAGE_LENGTH) return;

  const allGroups = await fetchSuggestableGroups();
  if (allGroups.length === 0) return;

  // getSuggestableGroups() already gates on agent_in_group; keep the set
  // check as a belt-and-suspenders guard against cache drift.
  const memberIds = await NSGroupAdapter.getAgentGroupIdSet();
  const groups = allGroups.filter((g) => memberIds.has(g.groupId));
  if (groups.length === 0) return;

  const groupList = buildGroupList(groups, sourceGroupId);
  if (!groupList) return;

  try {
    const response = await openai.chat.completions.create({
      ...openAiChatParams({ model: DEFAULT_CHAT_MODEL, maxCompletionTokens: 150, temperature: 0.1 }),
      messages: [
        {
          role: "system",
          content: `You are an intent scorer for a community discovery system. A user sent a message in a group chat. Your job is to detect when someone is genuinely engaged with a topic. They're just talking, and you're reading between the lines trying to understand and connect them with the right community.

Rate the message 0-100 based on how strongly it signals genuine interest in a topic:
- 90-100: Deep engagement — the person is actively working on, building, or problem-solving around a specific topic
- 75-89: Active interest — the person is discussing a topic with genuine curiosity, sharing opinions, or seeking input from others
- 50-74: Topical mention — a topic surfaces but the message is mostly conversational
- 25-49: Passing reference — a topic is barely touched, the message is primarily social
- 0-24: No topical signal — greetings, reactions, single words, off-topic chatter

Available communities (sorted by activity score):
${groupList}

Return ONLY valid JSON:
{"score": number, "reasoning": "brief explanation", "detected_interests": ["tag1", "tag2"], "suggested_community_id": "groupId or null"}

Rules:
- Match based on what the person is TALKING ABOUT, not whether they're asking for a group
- Someone discussing trading IS interested in a trading community, even if they never ask for one
- Someone building with AI agents IS interested in an AI community
- suggested_community_id must be one of the listed community IDs, or null
- Do NOT suggest the source community (ID: ${sourceGroupId})
- When multiple communities match, prefer higher-activity ones (listed first)
- Greetings, single-word messages, and pure social chat should always score under 30`,
        },
        { role: "user", content: messageContent },
      ],
    });

    const raw = response.choices[0]?.message?.content?.trim();
    if (!raw) return;

    let result: ScorerResult;
    try {
      const jsonStr = raw.replace(/```json\n?/g, "").replace(/```/g, "").trim();
      result = JSON.parse(jsonStr);
    } catch {
      console.log(`🎯 Scorer: failed to parse LLM response: ${raw.slice(0, 100)}`);
      return;
    }

    console.log(`🎯 Scorer: "${messageContent.slice(0, 40)}..." → score=${result.score}, match=${result.suggested_community_id?.slice(0, 8) || "none"}`);

    if (result.score < SCORE_THRESHOLD || !result.suggested_community_id) return;

    const matchedGroup = groups.find((g) => g.groupId === result.suggested_community_id);
    if (!matchedGroup) return;

    const inserted = await RecommendationAdapter.insert({
      senderInboxId,
      senderWalletAddress,
      sourceGroupId,
      targetGroupId: matchedGroup.groupId,
      targetGroupName: matchedGroup.name,
      targetGroupImageUrl: matchedGroup.imageUrl,
      score: result.score,
      reasoning: result.reasoning,
      detectedInterests: result.detected_interests || [],
    });

    if (inserted) {
      console.log(`🎯 Scorer: queued recommendation "${matchedGroup.name}" for ${senderInboxId.slice(0, 12)}... (score: ${result.score})`);
    }
  } catch (err) {
    console.error("❌ Scorer error:", err);
  }
}
