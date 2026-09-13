import { defineConfig } from "drizzle-kit";
export default defineConfig({
  schema: "./src/schema.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      "postgresql://brixchat:brixchat@localhost:5434/brixchat",
  },
  strict: true,
});
