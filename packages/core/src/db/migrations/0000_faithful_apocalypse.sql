CREATE TABLE "button_click_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"inbox_id" text NOT NULL,
	"action_key" text NOT NULL,
	"clicked_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbound_message_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"inbox_id" text NOT NULL,
	"is_group" boolean DEFAULT false NOT NULL,
	"engaged" boolean DEFAULT true NOT NULL,
	"received_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"inbox_id" text NOT NULL,
	"wallet_address" text,
	"total_messages" integer DEFAULT 0,
	"reminders_created" integer DEFAULT 0,
	"first_seen_at" timestamp DEFAULT now(),
	"last_message_at" timestamp DEFAULT now(),
	"action_clicks" jsonb DEFAULT '{}'::jsonb,
	"last_proactive_dm_at" timestamp,
	"recommended_group_ids" jsonb DEFAULT '[]'::jsonb,
	"last_button_click_at" timestamp,
	CONSTRAINT "users_inbox_id_unique" UNIQUE("inbox_id")
);
--> statement-breakpoint
CREATE TABLE "base_mcp_oauth" (
	"sender_id" text PRIMARY KEY NOT NULL,
	"account_address" text,
	"access_token" text NOT NULL,
	"refresh_token" text,
	"expires_at" timestamp with time zone NOT NULL,
	"scope" text,
	"client_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fund_sessions" (
	"token" varchar(32) PRIMARY KEY NOT NULL,
	"payment_link_url" text NOT NULL,
	"user_phone" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "imessage_wallets" (
	"sender_id" text PRIMARY KEY NOT NULL,
	"account_name" text NOT NULL,
	"address" text NOT NULL,
	"first_seen_at" timestamp DEFAULT now(),
	"last_active_at" timestamp DEFAULT now(),
	"base_app_address" text,
	"tx_pref" text,
	"provisioned_via_contact" boolean DEFAULT false
);
--> statement-breakpoint
CREATE TABLE "onramp_user_data" (
	"user_phone" text PRIMARY KEY NOT NULL,
	"email" text,
	"tos_accepted_at" timestamp with time zone,
	"phone_verified_at" timestamp with time zone,
	"email_verified_at" timestamp with time zone,
	"pending_phone_otp" varchar(6),
	"pending_phone_otp_expires_at" timestamp with time zone,
	"pending_email_otp" varchar(6),
	"pending_email_otp_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_brain_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"content" text NOT NULL,
	"strategy_count" integer DEFAULT 0 NOT NULL,
	"trade_count" integer DEFAULT 0 NOT NULL,
	"compiled_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "strategies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"creator_inbox_id" text NOT NULL,
	"creator_wallet" text,
	"creator_basename" text,
	"prompt" text NOT NULL,
	"config" jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"execution_wallet_name" text,
	"execution_wallet_address" text,
	"default_collateral_usdc" numeric,
	"featured" boolean DEFAULT false NOT NULL,
	"realized_pnl_usd" numeric DEFAULT '0' NOT NULL,
	"high_water_mark_usd" numeric DEFAULT '0' NOT NULL,
	"trade_count" integer DEFAULT 0 NOT NULL,
	"max_drawdown_pct" numeric DEFAULT '0' NOT NULL,
	"days_live" integer DEFAULT 0 NOT NULL,
	"wiki_dirty" boolean DEFAULT false NOT NULL,
	"deployed_at" timestamp with time zone,
	"last_eval_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "strategy_fee_settlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"strategy_id" uuid NOT NULL,
	"fee_usd" numeric DEFAULT '0' NOT NULL,
	"profit_increment_usd" numeric DEFAULT '0' NOT NULL,
	"hwm_after" numeric DEFAULT '0' NOT NULL,
	"tx_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "strategy_mark_buffers" (
	"pair" text PRIMARY KEY NOT NULL,
	"samples" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "strategy_trades" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"strategy_id" uuid NOT NULL,
	"pair" text NOT NULL,
	"side" text NOT NULL,
	"mode" text NOT NULL,
	"tx_hash" text,
	"collateral_usdc" numeric DEFAULT '0' NOT NULL,
	"pnl_usd" numeric DEFAULT '0' NOT NULL,
	"trade_index" integer,
	"pair_index" integer,
	"open_price" numeric,
	"wallet_address" text,
	"closed_at" timestamp with time zone,
	"last_unrealized_usd" numeric,
	"is_paper" boolean DEFAULT false NOT NULL,
	"exit_reason" text,
	"close_price" numeric,
	"entry_regime" text,
	"duration_s" integer,
	"max_favorable_move_pct" numeric,
	"max_adverse_move_pct" numeric,
	"pnl_reconciled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "strategy_wiki_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"strategy_id" uuid NOT NULL,
	"content" text NOT NULL,
	"compiled_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "strategy_rewards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"strategy_id" uuid NOT NULL,
	"subscription_id" uuid,
	"creator_wallet" text NOT NULL,
	"follower_wallet" text,
	"profit_usd" numeric DEFAULT '0' NOT NULL,
	"creator_share_usd" numeric DEFAULT '0' NOT NULL,
	"platform_share_usd" numeric DEFAULT '0' NOT NULL,
	"settled_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "strategy_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"strategy_id" uuid NOT NULL,
	"follower_inbox_id" text NOT NULL,
	"follower_wallet" text,
	"copy_wallet_name" text NOT NULL,
	"copy_wallet_address" text,
	"allocation_usdc" numeric DEFAULT '0' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"high_water_mark_usd" numeric DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "price_alerts" (
	"id" serial PRIMARY KEY NOT NULL,
	"platform" text NOT NULL,
	"user_key" text NOT NULL,
	"dm_target" text,
	"source_conversation_id" text,
	"source_is_group" boolean DEFAULT false NOT NULL,
	"token_source" text NOT NULL,
	"token_id" text,
	"token_address" text,
	"chain_id" text,
	"symbol" text NOT NULL,
	"name" text,
	"metric" text DEFAULT 'price_usd' NOT NULL,
	"target_value" numeric NOT NULL,
	"direction" text NOT NULL,
	"current_value_at_create" numeric,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"triggered_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "portfolio_review_delivery_attempts" (
	"id" serial PRIMARY KEY NOT NULL,
	"subscription_id" integer NOT NULL,
	"platform" text NOT NULL,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"success" boolean NOT NULL,
	"error_message" text
);
--> statement-breakpoint
CREATE TABLE "portfolio_review_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"subscription_id" integer NOT NULL,
	"platform" text NOT NULL,
	"run_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"locked_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portfolio_review_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"subscription_id" integer NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"total_value_usd" numeric NOT NULL,
	"holdings_json" text NOT NULL,
	"avantis_json" text,
	"sentiment_json" text,
	"wallet_address" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portfolio_review_subscriptions" (
	"id" serial PRIMARY KEY NOT NULL,
	"platform" text NOT NULL,
	"user_key" text NOT NULL,
	"wallet_address" text NOT NULL,
	"dm_target" text,
	"local_time" text NOT NULL,
	"timezone" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"next_run_at" timestamp with time zone NOT NULL,
	"last_sent_at" timestamp with time zone,
	"processing_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auction_winners" (
	"id" serial PRIMARY KEY NOT NULL,
	"auction_id" integer NOT NULL,
	"winner_address" varchar(42) NOT NULL,
	"community_name" varchar(255) NOT NULL,
	"community_description" text,
	"community_link" varchar(500),
	"winning_bid" numeric(20, 6),
	"group_id" varchar(255),
	"start_time" timestamp NOT NULL,
	"expires_at" timestamp NOT NULL,
	"is_active" boolean DEFAULT true,
	"broadcast_dm_sent" boolean DEFAULT false,
	"synced_at" timestamp DEFAULT now(),
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "auction_winners_auction_id_unique" UNIQUE("auction_id")
);
--> statement-breakpoint
CREATE TABLE "boost_payments" (
	"id" serial PRIMARY KEY NOT NULL,
	"tx_hash" varchar(66) NOT NULL,
	"group_id" varchar(255) NOT NULL,
	"payer_address" varchar(42) NOT NULL,
	"amount_usdc" numeric(18, 6) NOT NULL,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "boost_payments_tx_hash_unique" UNIQUE("tx_hash")
);
--> statement-breakpoint
CREATE TABLE "group_permissions" (
	"id" serial PRIMARY KEY NOT NULL,
	"group_id" varchar(255) NOT NULL,
	"user_inbox_id" varchar(255) NOT NULL,
	"user_wallet_address" varchar(255),
	"permission_type" varchar(20) DEFAULT 'owner' NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "ns_groups" (
	"id" serial PRIMARY KEY NOT NULL,
	"group_id" varchar(255) NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"tags" text[],
	"metadata" jsonb,
	"instance_id" varchar(50) DEFAULT 'basemate',
	"image_url" varchar(500),
	"ai_generated_tags" jsonb,
	"is_suggestable" boolean DEFAULT false,
	"total_messages" integer DEFAULT 0,
	"last_message_at" timestamp,
	"total_members" integer DEFAULT 0,
	"agent_in_group" boolean DEFAULT true,
	"owner_basename" varchar(255),
	"invite_link" varchar(500),
	"paid_discovery" boolean DEFAULT false,
	"paid_discovery_expires_at" timestamp,
	"boost_score" integer DEFAULT 0,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "ns_groups_group_id_unique" UNIQUE("group_id")
);
--> statement-breakpoint
CREATE TABLE "trending_group_overrides" (
	"id" serial PRIMARY KEY NOT NULL,
	"slot_position" integer NOT NULL,
	"group_id" varchar(255) NOT NULL,
	"priority" integer DEFAULT 0,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "slot_position_range" CHECK ("trending_group_overrides"."slot_position" BETWEEN 1 AND 3)
);
--> statement-breakpoint
CREATE TABLE "group_activity_hourly" (
	"id" serial PRIMARY KEY NOT NULL,
	"group_id" varchar(255) NOT NULL,
	"hour_bucket" timestamp NOT NULL,
	"message_count" integer DEFAULT 0,
	"member_joins" integer DEFAULT 0,
	"member_leaves" integer DEFAULT 0,
	"active_user_ids" text[],
	"unique_active_users" integer DEFAULT 0,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "group_activity_hourly_group_id_hour_bucket_unique" UNIQUE("group_id","hour_bucket")
);
--> statement-breakpoint
CREATE TABLE "group_member_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"group_id" varchar(255) NOT NULL,
	"snapshot_date" text NOT NULL,
	"member_count" integer NOT NULL,
	"captured_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "group_member_snapshots_group_id_snapshot_date_unique" UNIQUE("group_id","snapshot_date")
);
--> statement-breakpoint
CREATE TABLE "groups" (
	"id" serial PRIMARY KEY NOT NULL,
	"group_id" text NOT NULL,
	"group_name" text NOT NULL,
	"group_type" text NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now(),
	"member_count" integer DEFAULT 0,
	"last_activity_at" timestamp,
	"description" text,
	"original_group_id" text,
	"is_active" boolean DEFAULT true,
	"total_messages" integer DEFAULT 0,
	"total_mentioned_messages" integer DEFAULT 0,
	"total_leaves" integer DEFAULT 0,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	CONSTRAINT "groups_group_id_unique" UNIQUE("group_id")
);
--> statement-breakpoint
CREATE TABLE "keyword_budgets" (
	"id" serial PRIMARY KEY NOT NULL,
	"keyword_id" integer NOT NULL,
	"total_budget_usdc" numeric(18, 6) DEFAULT '0' NOT NULL,
	"spent_usdc" numeric(18, 6) DEFAULT '0' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "keyword_budgets_keyword_id_unique" UNIQUE("keyword_id")
);
--> statement-breakpoint
CREATE TABLE "keyword_impressions" (
	"id" serial PRIMARY KEY NOT NULL,
	"keyword_id" integer,
	"platform" varchar(20) NOT NULL,
	"source_group_id" varchar(255),
	"user_id" varchar(255),
	"matched_text" text,
	"cost_usdc" numeric(18, 6) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "keywords" (
	"id" serial PRIMARY KEY NOT NULL,
	"keyword" text NOT NULL,
	"owner_wallet" varchar(255) NOT NULL,
	"target_group_id" varchar(255) NOT NULL,
	"target_group_type" varchar(20) NOT NULL,
	"target_group_name" varchar(255),
	"target_invite_link" text,
	"bid_usdc" numeric(18, 6) DEFAULT '0' NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"payment_id" text,
	"keyword_embedding" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_memory" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"inbox_id" text NOT NULL,
	"conversation_id" text,
	"kind" text NOT NULL,
	"content" text NOT NULL,
	"content_hash" text NOT NULL,
	"embedding" vector(1536) NOT NULL,
	"importance" real DEFAULT 0.5 NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "pending_recommendations" (
	"id" numeric PRIMARY KEY NOT NULL,
	"sender_inbox_id" text NOT NULL,
	"sender_wallet_address" text,
	"source_group_id" text NOT NULL,
	"target_group_id" text NOT NULL,
	"target_group_name" text NOT NULL,
	"target_group_image_url" text,
	"score" numeric NOT NULL,
	"reasoning" text,
	"detected_interests" text[],
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"sent_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "perp_profiles" (
	"inbox_id" text PRIMARY KEY NOT NULL,
	"risk_tier" text NOT NULL,
	"default_collateral_usdc" text NOT NULL,
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "user_memory" (
	"inbox_id" text PRIMARY KEY NOT NULL,
	"preferred_earn_venues" text[] DEFAULT '{}' NOT NULL,
	"last_trade_pair" text,
	"last_earn_asset" text,
	"notable" text,
	"trade_count" numeric DEFAULT '0' NOT NULL,
	"earn_count" numeric DEFAULT '0' NOT NULL,
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "imessage_phone_escrows" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"sender_id" text NOT NULL,
	"recipient_phone" text NOT NULL,
	"phone_hash" text NOT NULL,
	"token_address" text NOT NULL,
	"amount_atomic" numeric(78, 0) NOT NULL,
	"amount_display" text NOT NULL,
	"status" text DEFAULT 'link_created' NOT NULL,
	"deposit_tx_hash" text,
	"release_tx_hash" text,
	"released_to" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "protocol_volume_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"inbox_id" text NOT NULL,
	"protocol" text NOT NULL,
	"action" text NOT NULL,
	"token" text,
	"amount_usdc" numeric,
	"tx_hash" text,
	"notional_usdc" numeric,
	"confirmed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "token_launch_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"wallet_address" text NOT NULL,
	"token_symbol" text,
	"token_name" text,
	"status" text NOT NULL,
	"http_status" integer,
	"token_address" text,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "tx_confirmations" (
	"sid" text PRIMARY KEY NOT NULL,
	"sender_id" text NOT NULL,
	"from_address" text NOT NULL,
	"chain_id" text NOT NULL,
	"label" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"tx_hash" text,
	"mcp_request_id" text,
	"approval_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "copy_strategies" (
	"id" serial PRIMARY KEY NOT NULL,
	"platform" text NOT NULL,
	"user_key" text NOT NULL,
	"follower_wallet" text,
	"leader_wallet" text NOT NULL,
	"copy_wallet_name" text NOT NULL,
	"copy_wallet_address" text NOT NULL,
	"allocation_usd" numeric DEFAULT '0' NOT NULL,
	"max_trade_usd" numeric DEFAULT '0' NOT NULL,
	"max_slippage_bps" integer DEFAULT 200 NOT NULL,
	"allowed_tokens" text,
	"status" text DEFAULT 'active' NOT NULL,
	"dm_target" text,
	"realized_pnl_usd" numeric DEFAULT '0' NOT NULL,
	"copy_mode" text DEFAULT 'tokens' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "imessage_contacts" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"contact_owner" text NOT NULL,
	"contact" text,
	"contact_phone" text,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "account_link_members" (
	"link_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"user_key" text NOT NULL,
	"wallet_address" text,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_link_members_platform_user_key_pk" PRIMARY KEY("platform","user_key")
);
--> statement-breakpoint
CREATE TABLE "account_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connection_tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"platform" text NOT NULL,
	"user_key" text NOT NULL,
	"wallet_address" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "strategy_fee_settlements" ADD CONSTRAINT "strategy_fee_settlements_strategy_id_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."strategies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_trades" ADD CONSTRAINT "strategy_trades_strategy_id_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."strategies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_wiki_history" ADD CONSTRAINT "strategy_wiki_history_strategy_id_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."strategies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_rewards" ADD CONSTRAINT "strategy_rewards_strategy_id_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."strategies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_rewards" ADD CONSTRAINT "strategy_rewards_subscription_id_strategy_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."strategy_subscriptions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_subscriptions" ADD CONSTRAINT "strategy_subscriptions_strategy_id_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."strategies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_review_delivery_attempts" ADD CONSTRAINT "portfolio_review_delivery_attempts_subscription_id_portfolio_review_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."portfolio_review_subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_review_jobs" ADD CONSTRAINT "portfolio_review_jobs_subscription_id_portfolio_review_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."portfolio_review_subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_review_snapshots" ADD CONSTRAINT "portfolio_review_snapshots_subscription_id_portfolio_review_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."portfolio_review_subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "keyword_budgets" ADD CONSTRAINT "keyword_budgets_keyword_id_keywords_id_fk" FOREIGN KEY ("keyword_id") REFERENCES "public"."keywords"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "keyword_impressions" ADD CONSTRAINT "keyword_impressions_keyword_id_keywords_id_fk" FOREIGN KEY ("keyword_id") REFERENCES "public"."keywords"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imessage_contacts" ADD CONSTRAINT "imessage_contacts_contact_owner_imessage_wallets_sender_id_fk" FOREIGN KEY ("contact_owner") REFERENCES "public"."imessage_wallets"("sender_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imessage_contacts" ADD CONSTRAINT "imessage_contacts_contact_imessage_wallets_sender_id_fk" FOREIGN KEY ("contact") REFERENCES "public"."imessage_wallets"("sender_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_link_members" ADD CONSTRAINT "account_link_members_link_id_account_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."account_links"("id") ON DELETE cascade ON UPDATE no action;