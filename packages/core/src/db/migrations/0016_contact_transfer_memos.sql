ALTER TABLE "pending_pay_transactions" ADD COLUMN "transfer_memo" text;--> statement-breakpoint
ALTER TABLE "tx_confirmations" ADD COLUMN "transfer_memo" text;