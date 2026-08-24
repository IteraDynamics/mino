import "dotenv/config";
import { readFileSync, realpathSync } from "node:fs";
import { defineConfig } from "prisma/config";

export default defineConfig({
  // Prisma 7 supports schema folders. Keep the existing core schema intact and
  // let Personal add domain models in focused sibling .prisma files.
  schema: "prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: requiredDatabaseUrl(process.env),
  },
});

function requiredDatabaseUrl(environment: NodeJS.ProcessEnv): string {
  const inline = environment.DATABASE_URL?.trim();
  const file = environment.DATABASE_URL_FILE?.trim();
  if ((inline && file) || (!inline && !file)) {
    throw new Error("Prisma requires exactly one of DATABASE_URL or DATABASE_URL_FILE");
  }
  if (inline) {
    return inline;
  }

  let value: string;
  try {
    value = readFileSync(realpathSync(file!), "utf8").trim();
  } catch {
    throw new Error("DATABASE_URL_FILE must resolve to a readable file");
  }
  if (!value) {
    throw new Error("DATABASE_URL_FILE must not be empty");
  }
  return value;
}
