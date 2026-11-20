-- Durable conversation transcript storage.
-- Rows are written fire-and-forget after every user+assistant turn by DiscoveryAI.
-- The index on (conversation_id, created_at) powers the cold-start bootstrap query
-- that re-hydrates the in-process history map when Redis is cold (> 24h gap).

CREATE TABLE IF NOT EXISTS "conversation_messages" (
  "id"              SERIAL PRIMARY KEY,
  "inbox_id"        TEXT    NOT NULL,
  "conversation_id" TEXT    NOT NULL,
  "platform"        TEXT    NOT NULL,
  "role"            TEXT    NOT NULL,
  "content"         TEXT    NOT NULL,
  "created_at"      TIMESTAMP DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conv_messages_conv_id_idx"
  ON "conversation_messages" ("conversation_id", "created_at");
