const TRENDING_API = process.env.TRENDING_API_URL || "https://devconnectarg-production.up.railway.app/api/trending";

interface TrendingSlotGroup {
  groupId: string;
  name: string;
  description: string;
  memberCount: number;
  messageCount: number;
  imageUrl: string;
  topics: string[];
}

interface TrendingSlot {
  slot: number;
  group: TrendingSlotGroup;
  source: "live-algorithm" | "manual" | "auction";
  score: number;
}

export class TrendingService {
  async getTrendingSlots(slotCount: number = 3): Promise<TrendingSlot[]> {
    try {
      const res = await fetch(TRENDING_API);
      if (!res.ok) throw new Error(`Trending API returned ${res.status}`);

      const data = await res.json() as TrendingSlot[];
      return data.slice(0, slotCount);
    } catch (err: any) {
      console.error("❌ Error fetching trending:", err.message);
      return [];
    }
  }
}
