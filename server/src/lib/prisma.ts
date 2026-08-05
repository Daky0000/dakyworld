import { PrismaClient } from "@prisma/client";

// Single shared Prisma client instance for the whole process.
export const prisma = new PrismaClient();
