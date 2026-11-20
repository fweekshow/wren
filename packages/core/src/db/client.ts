/**
 * Drizzle ORM client — wraps the existing pg Pool from `discovery/db.ts`.
 *
 * We reuse the existing Pool rather than creating a second connection so
 * pool sizing and SSL configuration stay in one place. The raw `db` pool
 * is still available for any queries not yet migrated to Drizzle.
 */
import { drizzle } from "drizzle-orm/node-postgres";

import { db as pool } from "@/discovery/db.js";
import * as schema from "@/db/schema/index.js";

export const drizzleDb = drizzle(pool, { schema });
