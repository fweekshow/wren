/**
 * Run all pending Drizzle migrations.
 * Usage: bun src/db/migrate.ts
 * Env: DATABASE_URL must be set.
 */
import "@/load-env.js";

import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

import { db as pool } from "@/discovery/db.js";
import { ensurePortfolioSnapshotColumns } from "@/portfolio/snapshot.js";
import { ensurePendingPayDeliveryColumns } from "@/wallet/pendingPay.schema.js";
import { ensurePhoneEscrowClaimExpiryColumns } from "@/wallet/phoneEscrow.schema.js";

const db = drizzle(pool);

console.info("Running Drizzle migrations…");

await migrate(db, {
  migrationsFolder: fileURLToPath(new URL("./migrations/", import.meta.url)),
});

// Same repairs the bot runs on connect — keep migrate path aligned.
await ensurePendingPayDeliveryColumns();
await ensurePhoneEscrowClaimExpiryColumns();
await ensurePortfolioSnapshotColumns();

console.info("Migrations complete");
await pool.end();
