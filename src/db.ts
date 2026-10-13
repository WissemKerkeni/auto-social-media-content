// Prisma Client (Prisma 7 + node-postgres driver adapter). One instance per process.
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.ts';

export function createPrisma(connectionString = process.env.DATABASE_URL): PrismaClient {
  if (!connectionString) throw new Error('DATABASE_URL is not set (npm run setup creates it in .env)');
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}
