// Prisma 7 configuration. .env is not auto-loaded by Prisma 7, so dotenv is imported here.
// DATABASE_URL: local Docker Postgres (see .env); production uses its own env file.
import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    // process.env (not env()) so `prisma generate` / postinstall work before .env exists.
    url: process.env['DATABASE_URL'],
  },
});
