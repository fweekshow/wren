import {
  boolean,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
  varchar,
} from "drizzle-orm/pg-core";

export const groups = pgTable("groups", {
  id: serial("id").primaryKey(),
  groupId: text("group_id").unique().notNull(),
  groupName: text("group_name").notNull(),
  groupType: text("group_type").notNull(),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at").defaultNow(),
  memberCount: integer("member_count").default(0),
  lastActivityAt: timestamp("last_activity_at"),
  description: text("description"),
  originalGroupId: text("original_group_id"),
  isActive: boolean("is_active").default(true),
  totalMessages: integer("total_messages").default(0),
  totalMentionedMessages: integer("total_mentioned_messages").default(0),
  totalLeaves: integer("total_leaves").default(0),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
});

export const groupActivityHourly = pgTable(
  "group_activity_hourly",
  {
    id: serial("id").primaryKey(),
    groupId: varchar("group_id", { length: 255 }).notNull(),
    hourBucket: timestamp("hour_bucket").notNull(),
    messageCount: integer("message_count").default(0),
    memberJoins: integer("member_joins").default(0),
    memberLeaves: integer("member_leaves").default(0),
    activeUserIds: text("active_user_ids").array(),
    uniqueActiveUsers: integer("unique_active_users").default(0),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (t) => [unique().on(t.groupId, t.hourBucket)],
);

export const groupMemberSnapshots = pgTable(
  "group_member_snapshots",
  {
    id: serial("id").primaryKey(),
    groupId: varchar("group_id", { length: 255 }).notNull(),
    snapshotDate: text("snapshot_date").notNull(),
    memberCount: integer("member_count").notNull(),
    capturedAt: timestamp("captured_at").notNull().defaultNow(),
  },
  (t) => [unique().on(t.groupId, t.snapshotDate)],
);
