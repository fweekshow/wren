export interface GroupCandidate {
  id: string;
  title: string;
  description?: string | null;
  topics?: string[] | null;
  embedding?: number[] | null;
  memberCount?: number;
}

export interface ScorerMatch {
  groupId: string;
  groupTitle: string;
  score: number;
}

export interface RunScorerParams {
  platform: "telegram" | "xmtp";
  userId: string;
  sourceGroupId: string;
  message: string;
  getGroupCandidates: (excludeGroupId: string) => Promise<GroupCandidate[]>;
  onMatch: (match: ScorerMatch) => Promise<void>;
}
