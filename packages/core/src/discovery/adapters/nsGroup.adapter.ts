import { db } from "@/discovery/db.js";

export interface NSGroup {
  id: string;
  group_id: string; // XMTP group ID
  name: string;
  description?: string;
  tags?: string[]; // Tags for categorization (e.g., ["fitness", "burn-program", "morning"])
  metadata?: Record<string, any>; // Flexible metadata
  is_suggestable?: boolean; // Manual flag for group recommendations
  ai_generated_tags?: string[]; // AI-generated tags from group name analysis
  total_messages?: number; // Activity tracking
  last_message_at?: Date; // Last message timestamp
  total_members?: number; // Member count
  image_url?: string; // Group image
  instance_id?: string; // Which agent instance created this group ('enes', 'basemate', etc.)
  agent_in_group?: boolean; // Whether the agent is currently in this group (false if removed)
  owner_basename?: string | null; // Cached basename from Base chain for group owner
  invite_link?: string | null;
  paid_discovery?: boolean;
  paid_discovery_expires_at?: Date;
  boost_score?: number;
  created_at?: Date;
  updated_at?: Date;
}

export class NSGroupAdapter {
  /** @deprecated Tables are now managed via Drizzle migrations. */
  static async createTable(): Promise<void> {
    const client = await db.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS ns_groups (
          id SERIAL PRIMARY KEY,
          group_id VARCHAR(255) UNIQUE NOT NULL,
          name VARCHAR(255) NOT NULL,
          description TEXT,
          tags TEXT[], -- Array of tags for categorization
          metadata JSONB, -- Flexible metadata storage
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        -- Add index for faster searches
        CREATE INDEX IF NOT EXISTS idx_ns_groups_tags ON ns_groups USING GIN(tags);
        CREATE INDEX IF NOT EXISTS idx_ns_groups_metadata ON ns_groups USING GIN(metadata);
        
        -- Add missing columns if they don't exist (migration support)
        DO $$
        BEGIN
          -- instance_id column
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                         WHERE table_name='ns_groups' AND column_name='instance_id') THEN
            ALTER TABLE ns_groups ADD COLUMN instance_id VARCHAR(50) DEFAULT 'basemate';
            CREATE INDEX IF NOT EXISTS idx_ns_groups_instance ON ns_groups(instance_id);
          END IF;
          
          -- image_url column
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                         WHERE table_name='ns_groups' AND column_name='image_url') THEN
            ALTER TABLE ns_groups ADD COLUMN image_url VARCHAR(500);
          END IF;
          
          -- ai_generated_tags column
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                         WHERE table_name='ns_groups' AND column_name='ai_generated_tags') THEN
            ALTER TABLE ns_groups ADD COLUMN ai_generated_tags JSONB;
          END IF;
          
          -- is_suggestable column
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                         WHERE table_name='ns_groups' AND column_name='is_suggestable') THEN
            ALTER TABLE ns_groups ADD COLUMN is_suggestable BOOLEAN DEFAULT false;
          END IF;
          
          -- total_messages column
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                         WHERE table_name='ns_groups' AND column_name='total_messages') THEN
            ALTER TABLE ns_groups ADD COLUMN total_messages INTEGER DEFAULT 0;
          END IF;
          
          -- last_message_at column
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                         WHERE table_name='ns_groups' AND column_name='last_message_at') THEN
            ALTER TABLE ns_groups ADD COLUMN last_message_at TIMESTAMP;
          END IF;
          
          -- total_members column
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                         WHERE table_name='ns_groups' AND column_name='total_members') THEN
            ALTER TABLE ns_groups ADD COLUMN total_members INTEGER DEFAULT 0;
          END IF;
          
          -- agent_in_group column
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                         WHERE table_name='ns_groups' AND column_name='agent_in_group') THEN
            ALTER TABLE ns_groups ADD COLUMN agent_in_group BOOLEAN DEFAULT true;
          END IF;
          
          -- owner_basename column for caching Base name lookups
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                         WHERE table_name='ns_groups' AND column_name='owner_basename') THEN
            ALTER TABLE ns_groups ADD COLUMN owner_basename VARCHAR(255);
            CREATE INDEX IF NOT EXISTS idx_ns_groups_owner_basename ON ns_groups(owner_basename);
          END IF;
          
          -- invite_link column for group owners to provide a join link
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                         WHERE table_name='ns_groups' AND column_name='invite_link') THEN
            ALTER TABLE ns_groups ADD COLUMN invite_link VARCHAR(500);
          END IF;
          
          -- paid_discovery columns for $5/week boost
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                         WHERE table_name='ns_groups' AND column_name='paid_discovery') THEN
            ALTER TABLE ns_groups ADD COLUMN paid_discovery BOOLEAN DEFAULT false;
            CREATE INDEX IF NOT EXISTS idx_ns_groups_paid_discovery ON ns_groups(paid_discovery);
          END IF;
          
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                         WHERE table_name='ns_groups' AND column_name='paid_discovery_expires_at') THEN
            ALTER TABLE ns_groups ADD COLUMN paid_discovery_expires_at TIMESTAMP;
          END IF;
          
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                         WHERE table_name='ns_groups' AND column_name='boost_score') THEN
            ALTER TABLE ns_groups ADD COLUMN boost_score INTEGER DEFAULT 0;
          END IF;
        END $$;
      `);

      // Boost payments table for tx hash verification and replay protection
      await client.query(`
        CREATE TABLE IF NOT EXISTS boost_payments (
          id SERIAL PRIMARY KEY,
          tx_hash VARCHAR(66) UNIQUE NOT NULL,
          group_id VARCHAR(255) NOT NULL,
          payer_address VARCHAR(42) NOT NULL,
          amount_usdc NUMERIC(18,6) NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);

      // Create group_permissions table to track owners/admins
      await client.query(`
        CREATE TABLE IF NOT EXISTS group_permissions (
          id SERIAL PRIMARY KEY,
          group_id VARCHAR(255) NOT NULL,
          user_inbox_id VARCHAR(255) NOT NULL,
          user_wallet_address VARCHAR(255),
          permission_type VARCHAR(20) NOT NULL DEFAULT 'owner', -- 'owner' or 'admin'
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(group_id, user_inbox_id)
        );
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_group_permissions_group ON group_permissions(group_id);
        CREATE INDEX IF NOT EXISTS idx_group_permissions_user ON group_permissions(user_inbox_id);
        CREATE INDEX IF NOT EXISTS idx_group_permissions_type ON group_permissions(permission_type);
      `);
      

      // Create trending_group_overrides table for manual trending slot management
      await client.query(`
        CREATE TABLE IF NOT EXISTS trending_group_overrides (
          id SERIAL PRIMARY KEY,
          slot_position INTEGER NOT NULL CHECK (slot_position >= 1 AND slot_position <= 3),
          group_id VARCHAR(255) NOT NULL,
          priority INTEGER DEFAULT 0,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(slot_position, group_id)
        );
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_trending_overrides_slot ON trending_group_overrides(slot_position);
        CREATE INDEX IF NOT EXISTS idx_trending_overrides_group ON trending_group_overrides(group_id);
      `);

      // Create auction_winners table to store winners from the auction contract
      await client.query(`
        CREATE TABLE IF NOT EXISTS auction_winners (
          id SERIAL PRIMARY KEY,
          auction_id INTEGER NOT NULL,
          winner_address VARCHAR(42) NOT NULL,
          community_name VARCHAR(255) NOT NULL,
          community_description TEXT,
          community_link VARCHAR(500),
          winning_bid NUMERIC(20, 6), -- USDC amount (6 decimals)
          group_id VARCHAR(255), -- Optional: linked XMTP group
          start_time TIMESTAMP NOT NULL,
          expires_at TIMESTAMP NOT NULL,
          is_active BOOLEAN DEFAULT true,
          synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(auction_id)
        );

        CREATE INDEX IF NOT EXISTS idx_auction_winners_active ON auction_winners(is_active, expires_at);
        CREATE INDEX IF NOT EXISTS idx_auction_winners_address ON auction_winners(winner_address);
      `);

      // Migration: add broadcast_dm_sent column
      await client.query(`
        ALTER TABLE auction_winners
        ADD COLUMN IF NOT EXISTS broadcast_dm_sent BOOLEAN DEFAULT false;
      `);
      
      console.log("✅ NS Groups and Auction Winners tables created or already exists");
    } finally {
      client.release();
    }
  }

  /**
   * Add or update a group
   */
  static async upsertGroup(group: Omit<NSGroup, 'id' | 'created_at' | 'updated_at'>): Promise<void> {
    const client = await db.connect();
    try {
      await client.query(
        `INSERT INTO ns_groups (group_id, name, description, tags, metadata, image_url, ai_generated_tags, is_suggestable, total_messages, last_message_at, total_members, instance_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (group_id) 
         DO UPDATE SET 
           name = EXCLUDED.name,
           description = EXCLUDED.description,
           tags = EXCLUDED.tags,
           metadata = EXCLUDED.metadata,
           image_url = EXCLUDED.image_url,
           ai_generated_tags = EXCLUDED.ai_generated_tags,
           is_suggestable = EXCLUDED.is_suggestable,
           total_messages = EXCLUDED.total_messages,
           last_message_at = EXCLUDED.last_message_at,
           total_members = EXCLUDED.total_members,
           instance_id = COALESCE(EXCLUDED.instance_id, ns_groups.instance_id),
           updated_at = CURRENT_TIMESTAMP`,
        [
          group.group_id,
          group.name,
          group.description || null,
          group.tags || [],
          group.metadata ? JSON.stringify(group.metadata) : null,
          group.image_url || null,
          JSON.stringify(group.ai_generated_tags || []), // JSONB column needs stringified JSON
          group.is_suggestable ?? false,
          group.total_messages ?? 0,
          group.last_message_at || null,
          group.total_members ?? 0,
          group.instance_id || 'basemate', // Default to 'basemate' for this agent
        ]
      );
    } finally {
      client.release();
    }
  }

  /**
   * Update owner_basename for a group by group_id
   */
  static async updateOwnerBasename(groupId: string, basename: string): Promise<void> {
    const client = await db.connect();
    try {
      await client.query(
        `UPDATE ns_groups SET owner_basename = $1, updated_at = CURRENT_TIMESTAMP WHERE group_id = $2`,
        [basename, groupId]
      );
    } finally {
      client.release();
    }
  }

  /**
   * Get all groups
   */
  static async getAllGroups(): Promise<NSGroup[]> {
    const client = await db.connect();
    try {
      const result = await client.query(
        'SELECT * FROM ns_groups ORDER BY name'
      );
      return result.rows;
    } finally {
      client.release();
    }
  }

  /**
   * Get a group by group_id
   */
  static async getGroupById(groupId: string): Promise<NSGroup | null> {
    const client = await db.connect();
    try {
      const result = await client.query(
        'SELECT * FROM ns_groups WHERE group_id = $1',
        [groupId]
      );
      return result.rows[0] || null;
    } finally {
      client.release();
    }
  }

  /**
   * Search groups by tags
   */
  static async searchByTags(tags: string[]): Promise<NSGroup[]> {
    const client = await db.connect();
    try {
      const result = await client.query(
        'SELECT * FROM ns_groups WHERE tags && $1 ORDER BY name',
        [tags]
      );
      return result.rows;
    } finally {
      client.release();
    }
  }

  /**
   * Delete a group
   */
  static async deleteGroup(groupId: string): Promise<void> {
    const client = await db.connect();
    try {
      await client.query(
        'DELETE FROM ns_groups WHERE group_id = $1',
        [groupId]
      );
    } finally {
      client.release();
    }
  }

  /**
   * Get all suggestable groups (is_suggestable = true).
   * Only returns groups where the agent is currently a member, so we never
   * recommend a group we can't actually add users to.
   */
  static async getSuggestableGroups(): Promise<NSGroup[]> {
    const client = await db.connect();
    try {
      const result = await client.query(`
        SELECT * FROM ns_groups 
        WHERE is_suggestable = true
          AND agent_in_group = true
        ORDER BY name ASC
      `);
      return result.rows;
    } finally {
      client.release();
    }
  }

  /**
   * Get all suggestable groups with owner basename (for trending display).
   * Gated by agent_in_group so the boost trending list never surfaces groups
   * we can't add users to.
   */
  static async getSuggestableGroupsWithOwner(): Promise<(NSGroup & { owner_wallet?: string })[]> {
    const client = await db.connect();
    try {
      const result = await client.query<NSGroup & { owner_wallet?: string }>(`
        SELECT g.*, p.user_wallet_address as owner_wallet
        FROM ns_groups g
        LEFT JOIN group_permissions p ON g.group_id = p.group_id AND p.permission_type = 'owner'
        WHERE g.is_suggestable = true
          AND g.agent_in_group = true
        ORDER BY g.name ASC
      `);
      return result.rows;
    } finally {
      client.release();
    }
  }

  /**
   * Get active community groups (strict quality filter)
   * Active if: recently active (24hrs) AND established (10+ messages)
   * Core groups always show regardless - this is just for community groups
   * 
   * @param hoursActive - How many hours to look back for activity
   * @param options.instanceId - Filter to specific instance (e.g., 'enes', 'basemate')
   * @param options.includeCrossNetwork - If true, include groups from all instances
   */
  static async getActiveGroups(
    hoursActive: number = 24,
    options?: { instanceId?: string; includeCrossNetwork?: boolean }
  ): Promise<NSGroup[]> {
    const { instanceId, includeCrossNetwork = false } = options || {};
    const client = await db.connect();
    try {
      let whereClause = `
        is_suggestable = true
        AND agent_in_group = true
        AND last_message_at IS NOT NULL
        AND last_message_at > NOW() - INTERVAL '${hoursActive} hours'
        AND total_messages > 10
      `;
      
      const params: unknown[] = [];

      // Filter by instance unless cross-network is enabled
      if (instanceId && !includeCrossNetwork) {
        params.push(instanceId);
        whereClause += ` AND (instance_id = $${params.length} OR instance_id IS NULL)`;
      }
      
      const result = await client.query<NSGroup>(
        `SELECT * FROM ns_groups WHERE ${whereClause} ORDER BY last_message_at DESC`,
        params.length > 0 ? params : undefined,
      );
      return result.rows;
    } finally {
      client.release();
    }
  }

  /**
   * Increment message count and update last message time (passive activity tracking)
   * Used like read receipts - tracks activity without processing messages
   */
  static async incrementMessageCount(groupId: string, userInboxId?: string): Promise<void> {
    const client = await db.connect();
    try {
      // Update main group table
      await client.query(`
        UPDATE ns_groups 
        SET 
          total_messages = COALESCE(total_messages, 0) + 1,
          last_message_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
        WHERE group_id = $1
      `, [groupId]);
      
      // Track in hourly activity for trending (NEW)
      if (userInboxId) {
        const { ActivityAdapter } = await import("./activity.adapter.js");
        await ActivityAdapter.incrementMessage(groupId, userInboxId);
      }
    } finally {
      client.release();
    }
  }

  /**
   * Update member count for a group
   */
  static async updateMemberCount(groupId: string, memberCount: number): Promise<void> {
    const client = await db.connect();
    try {
      await client.query(`
        UPDATE ns_groups 
        SET total_members = $2, updated_at = CURRENT_TIMESTAMP
        WHERE group_id = $1
      `, [groupId, memberCount]);
    } finally {
      client.release();
    }
  }


  /**
   * Update suggestability status for a group
   */
  static async updateSuggestability(groupId: string, isSuggestable: boolean): Promise<void> {
    const client = await db.connect();
    try {
      await client.query(`
        UPDATE ns_groups 
        SET is_suggestable = $2, updated_at = CURRENT_TIMESTAMP
        WHERE group_id = $1
      `, [groupId, isSuggestable]);
      console.log(`✅ Updated suggestability for ${groupId}: ${isSuggestable}`);
    } finally {
      client.release();
    }
  }

  /**
   * Update agent_in_group status (when agent is added or removed)
   */
  static async updateAgentInGroup(groupId: string, agentInGroup: boolean): Promise<void> {
    const client = await db.connect();
    try {
      await client.query(`
        UPDATE ns_groups 
        SET agent_in_group = $2, updated_at = CURRENT_TIMESTAMP
        WHERE group_id = $1
      `, [groupId, agentInGroup]);
      if (!agentInGroup) {
        await client.query(`
          UPDATE pending_recommendations
          SET status = 'failed'
          WHERE status = 'pending' AND target_group_id = $1
        `, [groupId]);
      }
      console.log(`✅ Updated agent_in_group for ${groupId}: ${agentInGroup}`);
    } finally {
      client.release();
    }
  }

  /**
   * Reconcile agent_in_group flags against the actual live XMTP membership.
   *
   * Used on startup (and as a safety net) to clean up stale rows after a
   * wallet/inbox change, removals, or any drift between Postgres and the
   * agent's local XMTP DB.
   *
   * Scope: only this instance's rows (instance_id='basemate' or NULL). Other
   * instances using the same shared DB are left untouched.
   *
   * @param liveGroupIds - group_ids the agent is currently a member of
   * @param instanceId - which instance to reconcile (defaults to 'basemate')
   */
  static async reconcileAgentMembership(
    liveGroupIds: string[],
    instanceId: string = "basemate",
  ): Promise<{
    inCount: number;
    clearedCount: number;
    reactivatedCount: number;
    failedPending: number;
  }> {
    const client = await db.connect();
    try {
      await client.query("BEGIN");

      // 1) Clear flag for all of our rows that currently say true
      const clearRes = await client.query(
        `UPDATE ns_groups
         SET agent_in_group = false, updated_at = CURRENT_TIMESTAMP
         WHERE (instance_id = $1 OR instance_id IS NULL)
           AND agent_in_group = true`,
        [instanceId],
      );

      // 2) Flip back to true for groups we're actually in
      let reactivatedCount = 0;
      if (liveGroupIds.length > 0) {
        const setRes = await client.query(
          `UPDATE ns_groups
           SET agent_in_group = true, updated_at = CURRENT_TIMESTAMP
           WHERE group_id = ANY($1::varchar[])`,
          [liveGroupIds],
        );
        reactivatedCount = setRes.rowCount || 0;
      }

      await client.query("COMMIT");

      const cleared = clearRes.rowCount || 0;

      const { RecommendationAdapter } = await import(
        "@/discovery/adapters/recommendation.adapter.js"
      );
      const failedPending = await RecommendationAdapter.failPendingForUnreachableGroups();

      return {
        inCount: liveGroupIds.length,
        clearedCount: Math.max(0, cleared - reactivatedCount),
        reactivatedCount,
        failedPending,
      };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Cached set of group_ids where agent_in_group = true.
   * Used by external-API gates (trending, scorer, keyword recs) to filter
   * results against the agent's real membership without re-querying Postgres
   * for every message.
   */
  private static _agentGroupIdSetCache: { ids: Set<string>; at: number } | null = null;
  private static readonly AGENT_GROUP_ID_SET_TTL_MS = 60_000;

  static async getAgentGroupIdSet(forceRefresh: boolean = false): Promise<Set<string>> {
    const now = Date.now();
    if (
      !forceRefresh &&
      this._agentGroupIdSetCache &&
      now - this._agentGroupIdSetCache.at < this.AGENT_GROUP_ID_SET_TTL_MS
    ) {
      return this._agentGroupIdSetCache.ids;
    }

    const client = await db.connect();
    try {
      const result = await client.query<{ group_id: string }>(
        `SELECT group_id FROM ns_groups WHERE agent_in_group = true`,
      );
      const ids = new Set(result.rows.map((r) => r.group_id));
      this._agentGroupIdSetCache = { ids, at: now };
      return ids;
    } finally {
      client.release();
    }
  }

  /**
   * Invalidate the cached agent-membership set. Call after reconcile or
   * onGroupUpdate so the next discovery surface sees fresh data.
   */
  static invalidateAgentGroupIdSet(): void {
    this._agentGroupIdSetCache = null;
  }

  /**
   * Get group by ID prefix (for dynamic action IDs like join_18fa28b1_group)
   */
  static async getGroupByIdPrefix(prefix: string): Promise<NSGroup | null> {
    const client = await db.connect();
    try {
      const result = await client.query<NSGroup>(`
        SELECT * FROM ns_groups 
        WHERE group_id LIKE $1
        LIMIT 1
      `, [`${prefix}%`]);
      return result.rows[0] || null;
    } finally {
      client.release();
    }
  }

  /**
   * Check if a user is an owner or admin of a group
   */
  static async isGroupOwnerOrAdmin(
    groupId: string,
    userInboxId: string
  ): Promise<boolean> {
    const client = await db.connect();
    try {
      const result = await client.query(`
        SELECT permission_type FROM group_permissions
        WHERE group_id = $1 AND user_inbox_id = $2
      `, [groupId, userInboxId]);
      
      if (result.rows.length > 0) {
        const permissionType = result.rows[0].permission_type;
        return permissionType === 'owner' || permissionType === 'admin';
      }
      
      return false;
    } finally {
      client.release();
    }
  }

  /**
   * Add or update group permission (owner/admin)
   */
  static async upsertGroupPermission(
    groupId: string,
    userInboxId: string,
    userWalletAddress: string | null,
    permissionType: 'owner' | 'admin' = 'owner'
  ): Promise<void> {
    const client = await db.connect();
    try {
      await client.query(`
        INSERT INTO group_permissions (group_id, user_inbox_id, user_wallet_address, permission_type)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (group_id, user_inbox_id)
        DO UPDATE SET
          permission_type = EXCLUDED.permission_type,
          user_wallet_address = COALESCE(EXCLUDED.user_wallet_address, group_permissions.user_wallet_address),
          updated_at = CURRENT_TIMESTAMP
      `, [groupId, userInboxId, userWalletAddress, permissionType]);
    } finally {
      client.release();
    }
  }

  /**
   * Update group description and generate AI tags
   */
  static async updateGroupDescription(
    groupId: string,
    description: string,
    aiGeneratedTags: string[]
  ): Promise<void> {
    const client = await db.connect();
    try {
      const tagsJson = JSON.stringify(aiGeneratedTags);
      const hasTags = aiGeneratedTags.length > 0;
      
      await client.query(`
        UPDATE ns_groups
        SET 
          description = $2,
          ai_generated_tags = $3::jsonb,
          is_suggestable = CASE 
            WHEN paid_discovery = true THEN true
            WHEN $4 AND COALESCE(total_members, 0) >= 5 THEN true 
            ELSE is_suggestable 
          END,
          updated_at = CURRENT_TIMESTAMP
        WHERE group_id = $1
      `, [groupId, description, tagsJson, hasTags]);
    } finally {
      client.release();
    }
  }

  /**
   * Get all trending group overrides (manual slot assignments)
   */
  static async getTrendingOverrides(): Promise<Array<{ slot_position: number; group_id: string; priority: number }>> {
    const client = await db.connect();
    try {
      const result = await client.query(`
        SELECT slot_position, group_id, priority
        FROM trending_group_overrides
        ORDER BY slot_position ASC, priority DESC
      `);
      return result.rows;
    } finally {
      client.release();
    }
  }

  /**
   * Set a group in a specific trending slot
   */
  static async setTrendingOverride(slotPosition: number, groupId: string): Promise<void> {
    if (slotPosition < 1 || slotPosition > 3) {
      throw new Error('Slot position must be between 1 and 3');
    }
    const client = await db.connect();
    try {
      await client.query(`
        INSERT INTO trending_group_overrides (slot_position, group_id, priority, updated_at)
        VALUES ($1, $2, 0, CURRENT_TIMESTAMP)
        ON CONFLICT (slot_position, group_id)
        DO UPDATE SET updated_at = CURRENT_TIMESTAMP
      `, [slotPosition, groupId]);
    } finally {
      client.release();
    }
  }

  /**
   * Clear a trending slot (let algorithm fill it)
   */
  static async clearTrendingOverride(slotPosition: number): Promise<void> {
    if (slotPosition < 1 || slotPosition > 3) {
      throw new Error('Slot position must be between 1 and 3');
    }
    const client = await db.connect();
    try {
      await client.query(`
        DELETE FROM trending_group_overrides
        WHERE slot_position = $1
      `, [slotPosition]);
    } finally {
      client.release();
    }
  }

  /**
   * Clear all trending overrides
   */
  static async clearAllTrendingOverrides(): Promise<void> {
    const client = await db.connect();
    try {
      await client.query(`DELETE FROM trending_group_overrides`);
    } finally {
      client.release();
    }
  }

  /**
   * Get ALL groups (suggestable + non-suggestable)
   */
  static async getAllGroupsWithScores(): Promise<NSGroup[]> {
    const client = await db.connect();
    try {
      const result = await client.query(`
        SELECT * FROM ns_groups
        ORDER BY name ASC
      `);
      return result.rows;
    } finally {
      client.release();
    }
  }

  /**
   * Toggle is_suggestable on/off for a group
   */
  static async toggleSuggestable(groupId: string): Promise<boolean> {
    const client = await db.connect();
    try {
      // Get current status
      const current = await client.query(`
        SELECT is_suggestable FROM ns_groups WHERE group_id = $1
      `, [groupId]);
      
      if (current.rows.length === 0) {
        throw new Error(`Group ${groupId} not found`);
      }
      
      const newStatus = !current.rows[0].is_suggestable;
      
      await client.query(`
        UPDATE ns_groups
        SET is_suggestable = $2, updated_at = CURRENT_TIMESTAMP
        WHERE group_id = $1
      `, [groupId, newStatus]);
      
      return newStatus;
    } finally {
      client.release();
    }
  }

  /**
   * Update group properties (name, description, tags)
   */
  static async updateGroupProperties(
    groupId: string,
    updates: { name?: string; description?: string; tags?: string[] }
  ): Promise<void> {
    const client = await db.connect();
    try {
      const setClauses: string[] = [];
      const values: any[] = [];
      let paramIndex = 1;
      
      if (updates.name !== undefined) {
        setClauses.push(`name = $${paramIndex++}`);
        values.push(updates.name);
      }
      
      if (updates.description !== undefined) {
        setClauses.push(`description = $${paramIndex++}`);
        values.push(updates.description);
      }
      
      if (updates.tags !== undefined) {
        setClauses.push(`tags = $${paramIndex++}`);
        values.push(updates.tags);
      }
      
      if (setClauses.length === 0) {
        return; // No updates to make
      }
      
      setClauses.push(`updated_at = CURRENT_TIMESTAMP`);
      values.push(groupId);
      
      await client.query(`
        UPDATE ns_groups
        SET ${setClauses.join(', ')}
        WHERE group_id = $${paramIndex}
      `, values);
    } finally {
      client.release();
    }
  }

  // ============ Auction Eligibility Methods ============

  /**
   * Get all groups where Basemate is currently in (agent_in_group = true)
   * Used for auction eligibility - only groups with Basemate can be in auction
   */
  static async getGroupsWithAgent(): Promise<NSGroup[]> {
    const client = await db.connect();
    try {
      const result = await client.query<NSGroup>(`
        SELECT * FROM ns_groups 
        WHERE agent_in_group = true
        ORDER BY name ASC
      `);
      return result.rows;
    } finally {
      client.release();
    }
  }

  /**
   * Get all groups where Basemate is in, including owner wallet address
   * Used for auction-miniapp group selection dropdown with owner profiles
   */
  static async getGroupsWithAgentAndOwner(): Promise<(NSGroup & { owner_wallet?: string })[]> {
    const client = await db.connect();
    try {
      const result = await client.query<NSGroup & { owner_wallet?: string }>(`
        SELECT g.*, p.user_wallet_address as owner_wallet
        FROM ns_groups g
        LEFT JOIN group_permissions p ON g.group_id = p.group_id AND p.permission_type = 'owner'
        WHERE g.agent_in_group = true
        ORDER BY g.name ASC
      `);
      return result.rows;
    } finally {
      client.release();
    }
  }

  /**
   * Get a group by exact name match (case-insensitive)
   * Used to validate auction bids
   */
  static async getGroupByName(name: string): Promise<NSGroup | null> {
    const client = await db.connect();
    try {
      const result = await client.query<NSGroup>(`
        SELECT * FROM ns_groups 
        WHERE LOWER(name) = LOWER($1)
        LIMIT 1
      `, [name]);
      return result.rows[0] || null;
    } finally {
      client.release();
    }
  }

  /**
   * Get groups owned by a specific wallet address
   * Used to show bidders their eligible groups
   */
  static async getGroupsByOwner(walletAddress: string): Promise<NSGroup[]> {
    const client = await db.connect();
    try {
      const result = await client.query<NSGroup>(`
        SELECT DISTINCT g.* 
        FROM ns_groups g
        INNER JOIN group_permissions p ON g.group_id = p.group_id
        WHERE LOWER(p.user_wallet_address) = LOWER($1)
          AND p.permission_type IN ('owner', 'admin')
        ORDER BY g.name ASC
      `, [walletAddress]);
      return result.rows;
    } finally {
      client.release();
    }
  }

  // ============ Auction Winners Methods ============

  /**
   * Get auction winner by auction ID (for join handlers)
   */
  static async getAuctionWinnerByAuctionId(auctionId: number): Promise<{
    auctionId: number;
    winnerAddress: string;
    communityName: string;
    communityDescription: string | null;
    communityLink: string | null;
    winningBid: number | null;
    groupId: string | null;
    startTime: Date;
    expiresAt: Date;
  } | null> {
    const client = await db.connect();
    try {
      const result = await client.query(`
        SELECT auction_id, winner_address, community_name, community_description,
               community_link, winning_bid, group_id, start_time, expires_at
        FROM auction_winners
        WHERE auction_id = $1
        LIMIT 1
      `, [auctionId]);
      if (result.rows.length === 0) return null;
      const row = result.rows[0];
      return {
        auctionId: row.auction_id,
        winnerAddress: row.winner_address,
        communityName: row.community_name,
        communityDescription: row.community_description,
        communityLink: row.community_link,
        winningBid: row.winning_bid ? parseFloat(row.winning_bid) : null,
        groupId: row.group_id,
        startTime: row.start_time,
        expiresAt: row.expires_at,
      };
    } finally {
      client.release();
    }
  }

  /**
   * Get the current active auction winner
   */
  static async getActiveAuctionWinner(): Promise<{
    auctionId: number;
    winnerAddress: string;
    communityName: string;
    communityDescription: string | null;
    communityLink: string | null;
    winningBid: number | null;
    groupId: string | null;
    startTime: Date;
    expiresAt: Date;
  } | null> {
    const client = await db.connect();
    try {
      const result = await client.query(`
        SELECT auction_id, winner_address, community_name, community_description,
               community_link, winning_bid, group_id, start_time, expires_at
        FROM auction_winners
        WHERE is_active = true AND expires_at > NOW()
        ORDER BY auction_id DESC
        LIMIT 1
      `);
      
      if (result.rows.length === 0) {
        return null;
      }
      
      const row = result.rows[0];
      return {
        auctionId: row.auction_id,
        winnerAddress: row.winner_address,
        communityName: row.community_name,
        communityDescription: row.community_description,
        communityLink: row.community_link,
        winningBid: row.winning_bid ? parseFloat(row.winning_bid) : null,
        groupId: row.group_id,
        startTime: row.start_time,
        expiresAt: row.expires_at,
      };
    } finally {
      client.release();
    }
  }

  /**
   * Upsert an auction winner (called when syncing from contract)
   */
  static async upsertAuctionWinner(winner: {
    auctionId: number;
    winnerAddress: string;
    communityName: string;
    communityDescription?: string;
    communityLink?: string;
    winningBid?: number;
    groupId?: string;
    startTime: Date;
    expiresAt: Date;
    isActive: boolean;
  }): Promise<void> {
    const client = await db.connect();
    try {
      await client.query(`
        INSERT INTO auction_winners (
          auction_id, winner_address, community_name, community_description,
          community_link, winning_bid, group_id, start_time, expires_at, is_active,
          synced_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), NOW())
        ON CONFLICT (auction_id)
        DO UPDATE SET
          winner_address = EXCLUDED.winner_address,
          community_name = EXCLUDED.community_name,
          community_description = EXCLUDED.community_description,
          community_link = EXCLUDED.community_link,
          winning_bid = EXCLUDED.winning_bid,
          group_id = EXCLUDED.group_id,
          start_time = EXCLUDED.start_time,
          expires_at = EXCLUDED.expires_at,
          is_active = EXCLUDED.is_active,
          synced_at = NOW(),
          updated_at = NOW()
      `, [
        winner.auctionId,
        winner.winnerAddress,
        winner.communityName,
        winner.communityDescription || null,
        winner.communityLink || null,
        winner.winningBid || null,
        winner.groupId || null,
        winner.startTime,
        winner.expiresAt,
        winner.isActive,
      ]);
    } finally {
      client.release();
    }
  }

  /**
   * Link a group to an auction winner
   */
  static async linkGroupToAuctionWinner(auctionId: number, groupId: string): Promise<void> {
    const client = await db.connect();
    try {
      await client.query(`
        UPDATE auction_winners
        SET group_id = $2, updated_at = NOW()
        WHERE auction_id = $1
      `, [auctionId, groupId]);
    } finally {
      client.release();
    }
  }

  /**
   * Deactivate expired auction winners
   */
  static async deactivateExpiredWinners(): Promise<number> {
    const client = await db.connect();
    try {
      const result = await client.query(`
        UPDATE auction_winners
        SET is_active = false, updated_at = NOW()
        WHERE is_active = true AND expires_at <= NOW()
        RETURNING id
      `);
      return result.rowCount || 0;
    } finally {
      client.release();
    }
  }

  /**
   * Get all auction winners (for history)
   */
  static async getAllAuctionWinners(): Promise<Array<{
    auctionId: number;
    winnerAddress: string;
    communityName: string;
    communityDescription: string | null;
    communityLink: string | null;
    winningBid: number | null;
    groupId: string | null;
    startTime: Date;
    expiresAt: Date;
    isActive: boolean;
  }>> {
    const client = await db.connect();
    try {
      const result = await client.query(`
        SELECT auction_id, winner_address, community_name, community_description,
               community_link, winning_bid, group_id, start_time, expires_at, is_active
        FROM auction_winners
        ORDER BY auction_id DESC
      `);
      
      return result.rows.map(row => ({
        auctionId: row.auction_id,
        winnerAddress: row.winner_address,
        communityName: row.community_name,
        communityDescription: row.community_description,
        communityLink: row.community_link,
        winningBid: row.winning_bid ? parseFloat(row.winning_bid) : null,
        groupId: row.group_id,
        startTime: row.start_time,
        expiresAt: row.expires_at,
        isActive: row.is_active,
      }));
    } finally {
      client.release();
    }
  }

  /**
   * Activate paid discovery boost for a group ($5/week)
   */
  static async activateBoost(groupId: string): Promise<{ expiresAt: Date }> {
    const client = await db.connect();
    try {
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      await client.query(`
        UPDATE ns_groups
        SET 
          paid_discovery = true,
          paid_discovery_expires_at = $2,
          boost_score = 50,
          is_suggestable = true,
          updated_at = CURRENT_TIMESTAMP
        WHERE group_id = $1
      `, [groupId, expiresAt]);
      return { expiresAt };
    } finally {
      client.release();
    }
  }

  static async isTxHashUsed(txHash: string): Promise<boolean> {
    const client = await db.connect();
    try {
      const result = await client.query(
        `SELECT 1 FROM boost_payments WHERE tx_hash = $1`,
        [txHash.toLowerCase()]
      );
      return result.rows.length > 0;
    } finally {
      client.release();
    }
  }

  static async recordBoostPayment(txHash: string, groupId: string, payerAddress: string, amountUsdc: number): Promise<void> {
    const client = await db.connect();
    try {
      await client.query(
        `INSERT INTO boost_payments (tx_hash, group_id, payer_address, amount_usdc)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (tx_hash) DO NOTHING`,
        [txHash.toLowerCase(), groupId, payerAddress.toLowerCase(), amountUsdc]
      );
    } finally {
      client.release();
    }
  }

  /**
   * Deactivate expired boosts
   */
  static async deactivateExpiredBoosts(): Promise<number> {
    const client = await db.connect();
    try {
      // Only flip the paid_discovery flag; keep boost_score and expiry date
      // so getBoostedGroups() can calculate a decaying residual.
      const result = await client.query(`
        UPDATE ns_groups
        SET
          paid_discovery = false,
          updated_at = CURRENT_TIMESTAMP
        WHERE paid_discovery = true
          AND paid_discovery_expires_at < CURRENT_TIMESTAMP
        RETURNING group_id
      `);
      return result.rowCount || 0;
    } finally {
      client.release();
    }
  }

  /**
   * Get boost status for a group
   */
  static async getBoostStatus(groupId: string): Promise<{
    paidDiscovery: boolean;
    expiresAt: Date | null;
    boostScore: number;
  }> {
    const client = await db.connect();
    try {
      const result = await client.query(`
        SELECT paid_discovery, paid_discovery_expires_at, boost_score
        FROM ns_groups WHERE group_id = $1
      `, [groupId]);
      if (result.rows.length === 0) {
        return { paidDiscovery: false, expiresAt: null, boostScore: 0 };
      }
      const row = result.rows[0];
      return {
        paidDiscovery: Boolean(row.paid_discovery),
        expiresAt: row.paid_discovery_expires_at || null,
        boostScore: row.boost_score || 0,
      };
    } finally {
      client.release();
    }
  }

  /**
   * Check if a wallet address is authorized to edit a group's tags/invite link.
   * Authorized = group owner (group_permissions) OR boost payer (boost_payments).
   */
  static async canEditGroup(groupId: string, walletAddress: string): Promise<boolean> {
    const client = await db.connect();
    try {
      const wallet = walletAddress.toLowerCase();
      const result = await client.query(`
        SELECT 1 FROM group_permissions
        WHERE group_id = $1 AND LOWER(user_wallet_address) = $2
          AND permission_type IN ('owner', 'admin')
        UNION
        SELECT 1 FROM boost_payments
        WHERE group_id = $1 AND LOWER(payer_address) = $2
        LIMIT 1
      `, [groupId, wallet]);
      return result.rows.length > 0;
    } finally {
      client.release();
    }
  }

  /**
   * Get tags for a group (manual + AI)
   */
  static async getGroupTags(groupId: string): Promise<{ manual: string[]; ai: string[] }> {
    const client = await db.connect();
    try {
      const result = await client.query(
        `SELECT tags, ai_generated_tags FROM ns_groups WHERE group_id = $1`,
        [groupId]
      );
      if (result.rows.length === 0) {
        return { manual: [], ai: [] };
      }
      const row = result.rows[0];
      const manual = Array.isArray(row.tags) ? row.tags : [];
      const aiRaw = row.ai_generated_tags;
      const ai = typeof aiRaw === 'string' ? JSON.parse(aiRaw) : (Array.isArray(aiRaw) ? aiRaw : []);
      return { manual, ai };
    } finally {
      client.release();
    }
  }

  /**
   * Update manual tags for a group (owner-set interest tags)
   */
  static async updateGroupTags(groupId: string, tags: string[]): Promise<void> {
    const client = await db.connect();
    try {
      await client.query(`
        UPDATE ns_groups
        SET tags = $2, updated_at = CURRENT_TIMESTAMP
        WHERE group_id = $1
      `, [groupId, tags]);
    } finally {
      client.release();
    }
  }

  /**
   * Update invite link for a group
   */
  static async updateInviteLink(groupId: string, inviteLink: string | null): Promise<void> {
    const client = await db.connect();
    try {
      await client.query(`
        UPDATE ns_groups
        SET invite_link = $2, updated_at = CURRENT_TIMESTAMP
        WHERE group_id = $1
      `, [groupId, inviteLink]);
    } finally {
      client.release();
    }
  }

  /**
   * Get invite link for a group
   */
  static async getInviteLink(groupId: string): Promise<string | null> {
    const client = await db.connect();
    try {
      const result = await client.query(
        `SELECT invite_link FROM ns_groups WHERE group_id = $1`,
        [groupId]
      );
      return result.rows[0]?.invite_link || null;
    } finally {
      client.release();
    }
  }

  /**
   * Get paid discovery groups that have owner-set tags (for proactive intent matching).
   */
  static async getPaidGroupsWithTags(): Promise<NSGroup[]> {
    const client = await db.connect();
    try {
      const result = await client.query(`
        SELECT * FROM ns_groups
        WHERE paid_discovery = true
          AND tags IS NOT NULL
          AND array_length(tags, 1) > 0
      `);
      return result.rows;
    } finally {
      client.release();
    }
  }

  /**
   * Get all groups with active boosts (for boost score lookups)
   */
  /**
   * Returns effective boost scores for all groups with any boost history.
   *
   * - Active boost (paid_discovery=true, not expired): full boost_score
   * - Expired boost: decays by half every 7 days, floor at 5% of original
   * - Past auction winners: +5 residual per past win (stacks)
   */
  static async getBoostedGroups(): Promise<Map<string, number>> {
    const client = await db.connect();
    try {
      const map = new Map<string, number>();

      // 1) Groups with boost_score > 0 (active or expired)
      const boostResult = await client.query(`
        SELECT group_id, boost_score, paid_discovery, paid_discovery_expires_at
        FROM ns_groups
        WHERE boost_score > 0
      `);

      const now = Date.now();
      for (const row of boostResult.rows) {
        const base = row.boost_score || 0;
        if (row.paid_discovery) {
          // Active boost — full score
          map.set(row.group_id, base);
        } else if (row.paid_discovery_expires_at) {
          // Expired — decay: halves every 7 days, floor at 5% of original
          const msExpired = now - new Date(row.paid_discovery_expires_at).getTime();
          const daysExpired = Math.max(0, msExpired / (1000 * 60 * 60 * 24));
          const decayed = base * Math.max(0.05, Math.pow(0.5, daysExpired / 7));
          const rounded = Math.round(decayed * 10) / 10;
          if (rounded >= 1) {
            map.set(row.group_id, rounded);
          }
        }
      }

      // 2) Past auction winners get +5 residual per win
      const auctionResult = await client.query(`
        SELECT group_id, COUNT(*) as win_count
        FROM auction_winners
        WHERE group_id IS NOT NULL
        GROUP BY group_id
      `);
      for (const row of auctionResult.rows) {
        const residual = Math.min(Number(row.win_count) * 5, 25); // cap at 25
        const current = map.get(row.group_id) || 0;
        map.set(row.group_id, current + residual);
      }

      return map;
    } finally {
      client.release();
    }
  }
}

