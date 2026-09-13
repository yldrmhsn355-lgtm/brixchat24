import { migrate } from "drizzle-orm/postgres-js/migrator";
import { fileURLToPath } from "node:url";
import { createDatabase } from "./index";
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const { db, client } = createDatabase(url);
const migrationsFolder = fileURLToPath(
  new URL("../migrations", import.meta.url),
);
await migrate(db, { migrationsFolder });
await client.end();
