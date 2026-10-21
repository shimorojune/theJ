/** Applies pending Drizzle migrations. Runs as a one-shot service before the app starts. */
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

const client = postgres(url, { max: 1 });
await migrate(drizzle(client), {
  migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
});
await client.end();
console.log("migrations applied");
