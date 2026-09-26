export const env = {
  DATABASE_URL: process.env.DATABASE_URL,
  PGLITE_DIR: process.env.PGLITE_DIR ?? "data/pglite",
  PORT: Number(process.env.PORT ?? 3100),
  AI_BASE_URL: process.env.AI_BASE_URL,
  AI_API_KEY: process.env.AI_API_KEY,
  AI_MODEL: process.env.AI_MODEL ?? "gpt-5.6-sol",
  PUBLISH_DELAY_MS: Number(process.env.PUBLISH_DELAY_MS ?? 400),
};
