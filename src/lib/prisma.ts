import { PrismaClient } from '@prisma/client';

// Singleton pattern — Next.js dev mode hot-reloads route handlers,
// and we don't want each reload spawning a new connection pool.

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
