import { db } from "@/discovery/db.js";

function parseEmbedding(raw: unknown): number[] | null {
  if (raw == null) return null;
  if (Array.isArray(raw) && raw.every((x) => typeof x === "number")) return raw as number[];
  if (typeof raw === "string") {
    try {
      const j = JSON.parse(raw) as unknown;
      return Array.isArray(j) && j.every((x) => typeof x === "number") ? (j as number[]) : null;
    } catch {
      return null;
    }
  }
  return null;
}

function mapKeywordWithBudgetRow(r: Record<string, unknown>): KeywordWithBudget {
  const { keyword_embedding: rawEmb, ...rest } = r;
  return {
    ...(rest as Omit<KeywordWithBudget, "keyword_embedding">),
    keyword_embedding: parseEmbedding(rawEmb),
  };
}

/** Keyword target: group invite on Telegram or Base App. */
export type KeywordTargetType = "telegram" | "base";

export type KeywordStatus = "active" | "paused" | "exhausted";

export interface KeywordRow {
  id: number;
  keyword: string;
  owner_wallet: string;
  target_group_id: string;
  target_group_type: KeywordTargetType;
  target_group_name: string | null;
  target_invite_link: string | null;
  bid_usdc: string;
  status: KeywordStatus;
  payment_id: string | null;
  keyword_embedding: number[] | null;
  created_at: Date;
  updated_at: Date;
}

export interface KeywordWithBudget extends KeywordRow {
  total_budget_usdc: string;
  spent_usdc: string;
}

export interface KeywordMarketplaceRow {
  id: number;
  keyword: string;
  bid_usdc: string;
  target_group_type: KeywordTargetType;
  target_group_name: string | null;
  impression_count: number;
}

export class KeywordAdapter {
  /** @deprecated Tables are now managed via Drizzle migrations. */
  static async createTable(): Promise<void> {
    const client = await db.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS keywords (
          id SERIAL PRIMARY KEY,
          keyword TEXT NOT NULL,
          owner_wallet VARCHAR(255) NOT NULL,
          target_group_id VARCHAR(255) NOT NULL,
          target_group_type VARCHAR(20) NOT NULL,
          target_group_name VARCHAR(255),
          target_invite_link TEXT,
          bid_usdc NUMERIC(18,6) NOT NULL DEFAULT 0,
          status VARCHAR(20) NOT NULL DEFAULT 'active',
          payment_id TEXT,
          keyword_embedding JSONB,
          created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_keywords_keyword_lower ON keywords (LOWER(keyword));
        CREATE INDEX IF NOT EXISTS idx_keywords_owner ON keywords(owner_wallet);
        CREATE INDEX IF NOT EXISTS idx_keywords_status ON keywords(status);

        CREATE TABLE IF NOT EXISTS keyword_budgets (
          id SERIAL PRIMARY KEY,
          keyword_id INT NOT NULL REFERENCES keywords(id) ON DELETE CASCADE,
          total_budget_usdc NUMERIC(18,6) NOT NULL DEFAULT 0,
          spent_usdc NUMERIC(18,6) NOT NULL DEFAULT 0,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(keyword_id)
        );

        CREATE TABLE IF NOT EXISTS keyword_impressions (
          id SERIAL PRIMARY KEY,
          keyword_id INT REFERENCES keywords(id) ON DELETE SET NULL,
          platform VARCHAR(20) NOT NULL,
          source_group_id VARCHAR(255),
          user_id VARCHAR(255),
          matched_text TEXT,
          cost_usdc NUMERIC(18,6) NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_keyword_impressions_kw ON keyword_impressions(keyword_id);
      `);
    } finally {
      client.release();
    }
  }

  static async insertKeyword(input: {
    keyword: string;
    ownerWallet: string;
    targetGroupId: string;
    targetGroupType: KeywordTargetType;
    targetGroupName: string | null;
    targetInviteLink: string | null;
    bidUsdc: number;
    totalBudgetUsdc: number;
    paymentId?: string | null;
    embedding?: number[] | null;
  }): Promise<number> {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const kwRes = await client.query<{ id: number }>(
        `INSERT INTO keywords
          (keyword, owner_wallet, target_group_id, target_group_type, target_group_name,
           target_invite_link, bid_usdc, status, payment_id)
         VALUES (LOWER(TRIM($1)), LOWER($2), $3, $4, $5, $6, $7, 'active', $8)
         RETURNING id`,
        [
          input.keyword,
          input.ownerWallet.toLowerCase(),
          input.targetGroupId,
          input.targetGroupType,
          input.targetGroupName,
          input.targetInviteLink,
          input.bidUsdc,
          input.paymentId ?? null,
        ],
      );
      const id = kwRes.rows[0]!.id;
      await client.query(
        `INSERT INTO keyword_budgets (keyword_id, total_budget_usdc, spent_usdc)
         VALUES ($1, $2, 0)`,
        [id, input.totalBudgetUsdc],
      );
      if (input.embedding?.length) {
        await client.query(
          `UPDATE keywords SET keyword_embedding = $1::jsonb, updated_at = NOW() WHERE id = $2`,
          [JSON.stringify(input.embedding), id],
        );
      }
      await client.query("COMMIT");
      return id;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  static async updateKeywordEmbedding(keywordId: number, embedding: number[]): Promise<void> {
    const client = await db.connect();
    try {
      await client.query(
        `UPDATE keywords SET keyword_embedding = $1::jsonb, updated_at = NOW() WHERE id = $2`,
        [JSON.stringify(embedding), keywordId],
      );
    } finally {
      client.release();
    }
  }

  static async listActiveWithBudget(): Promise<KeywordWithBudget[]> {
    const client = await db.connect();
    try {
      const res = await client.query<Record<string, unknown>>(
        `SELECT k.*, b.total_budget_usdc::text, b.spent_usdc::text
         FROM keywords k
         INNER JOIN keyword_budgets b ON b.keyword_id = k.id
         WHERE k.status = 'active'
           AND k.target_group_type IN ('telegram', 'base')
           AND b.spent_usdc < b.total_budget_usdc`,
      );
      return res.rows.map(mapKeywordWithBudgetRow);
    } finally {
      client.release();
    }
  }

  static async listMarketplace(): Promise<KeywordMarketplaceRow[]> {
    const client = await db.connect();
    try {
      const res = await client.query<KeywordMarketplaceRow>(
        `SELECT k.id, k.keyword, k.bid_usdc::text, k.target_group_type, k.target_group_name,
                COUNT(i.id)::int AS impression_count
         FROM keywords k
         LEFT JOIN keyword_impressions i ON i.keyword_id = k.id
         WHERE k.status = 'active'
           AND k.target_group_type IN ('telegram', 'base')
         GROUP BY k.id, k.keyword, k.bid_usdc, k.target_group_type, k.target_group_name
         ORDER BY k.bid_usdc DESC, k.keyword ASC`,
      );
      return res.rows;
    } finally {
      client.release();
    }
  }

  static async listByOwner(wallet: string): Promise<KeywordWithBudget[]> {
    const client = await db.connect();
    try {
      const res = await client.query<Record<string, unknown>>(
        `SELECT k.*, b.total_budget_usdc::text, b.spent_usdc::text
         FROM keywords k
         INNER JOIN keyword_budgets b ON b.keyword_id = k.id
         WHERE k.owner_wallet = LOWER($1)
         ORDER BY k.created_at DESC`,
        [wallet],
      );
      return res.rows.map(mapKeywordWithBudgetRow);
    } finally {
      client.release();
    }
  }

  static async getById(id: number): Promise<KeywordWithBudget | null> {
    const client = await db.connect();
    try {
      const res = await client.query<Record<string, unknown>>(
        `SELECT k.*, b.total_budget_usdc::text, b.spent_usdc::text
         FROM keywords k
         INNER JOIN keyword_budgets b ON b.keyword_id = k.id
         WHERE k.id = $1`,
        [id],
      );
      const row = res.rows[0];
      return row ? mapKeywordWithBudgetRow(row) : null;
    } finally {
      client.release();
    }
  }

  /**
   * Atomically deduct bid from budget, log impression, mark exhausted if needed.
   * Returns false if insufficient budget (race) or keyword inactive.
   */
  static async tryConsumeImpression(params: {
    keywordId: number;
    platform: "telegram" | "xmtp";
    sourceGroupId: string;
    userId: string;
    matchedText: string;
    costUsdc: number;
  }): Promise<boolean> {
    const client = await db.connect();
    try {
      await client.query("BEGIN");

      const lock = await client.query<{ id: number; bid_usdc: string; status: string }>(
        `SELECT k.id, k.bid_usdc::text, k.status
         FROM keywords k
         WHERE k.id = $1 FOR UPDATE`,
        [params.keywordId],
      );
      const row = lock.rows[0];
      if (!row || row.status !== "active") {
        await client.query("ROLLBACK");
        return false;
      }

      const budget = await client.query<{ spent: string; total: string }>(
        `SELECT spent_usdc::text, total_budget_usdc::text
         FROM keyword_budgets WHERE keyword_id = $1 FOR UPDATE`,
        [params.keywordId],
      );
      const b = budget.rows[0];
      if (!b) {
        await client.query("ROLLBACK");
        return false;
      }

      const spent = parseFloat(b.spent);
      const total = parseFloat(b.total);
      const cost = params.costUsdc;
      if (spent + cost > total + 1e-9) {
        await client.query("ROLLBACK");
        return false;
      }

      await client.query(
        `UPDATE keyword_budgets
         SET spent_usdc = spent_usdc + $1::numeric, updated_at = NOW()
         WHERE keyword_id = $2`,
        [cost, params.keywordId],
      );

      await client.query(
        `INSERT INTO keyword_impressions
          (keyword_id, platform, source_group_id, user_id, matched_text, cost_usdc)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          params.keywordId,
          params.platform,
          params.sourceGroupId,
          params.userId,
          params.matchedText.slice(0, 2000),
          cost,
        ],
      );

      const after = await client.query<{ spent: string; total: string }>(
        `SELECT spent_usdc::text, total_budget_usdc::text FROM keyword_budgets WHERE keyword_id = $1`,
        [params.keywordId],
      );
      const spentAfter = parseFloat(after.rows[0]!.spent);
      const totalAfter = parseFloat(after.rows[0]!.total);
      if (spentAfter >= totalAfter - 1e-9) {
        await client.query(`UPDATE keywords SET status = 'exhausted', updated_at = NOW() WHERE id = $1`, [
          params.keywordId,
        ]);
      }

      await client.query("COMMIT");
      return true;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  static async updateStatus(id: number, ownerWallet: string, status: KeywordStatus): Promise<boolean> {
    const client = await db.connect();
    try {
      const res = await client.query(
        `UPDATE keywords SET status = $1, updated_at = NOW()
         WHERE id = $2 AND owner_wallet = LOWER($3)`,
        [status, id, ownerWallet],
      );
      return (res.rowCount ?? 0) > 0;
    } finally {
      client.release();
    }
  }

  static async topUpBudget(
    id: number,
    ownerWallet: string,
    amountUsdc: number,
    paymentId?: string | null,
  ): Promise<boolean> {
    const client = await db.connect();
    try {
      const own = await client.query(
        `SELECT 1 FROM keywords WHERE id = $1 AND owner_wallet = LOWER($2)`,
        [id, ownerWallet],
      );
      if ((own.rowCount ?? 0) === 0) return false;

      await client.query(
        `UPDATE keyword_budgets
         SET total_budget_usdc = total_budget_usdc + $1::numeric, updated_at = NOW()
         WHERE keyword_id = $2`,
        [amountUsdc, id],
      );
      await client.query(
        `UPDATE keywords SET status = CASE WHEN status = 'exhausted' THEN 'active' ELSE status END,
             payment_id = COALESCE($2, payment_id), updated_at = NOW()
         WHERE id = $1`,
        [id, paymentId ?? null],
      );
      return true;
    } finally {
      client.release();
    }
  }

  static async updateBid(
    id: number,
    ownerWallet: string,
    bidUsdc: number,
  ): Promise<boolean> {
    const client = await db.connect();
    try {
      const res = await client.query(
        `UPDATE keywords SET bid_usdc = $1, updated_at = NOW()
         WHERE id = $2 AND owner_wallet = LOWER($3)`,
        [bidUsdc, id, ownerWallet],
      );
      return (res.rowCount ?? 0) > 0;
    } finally {
      client.release();
    }
  }

}
