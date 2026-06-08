-- CreateTable
CREATE TABLE "Config" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "provider" TEXT NOT NULL DEFAULT 'anthropic',
    "model" TEXT NOT NULL DEFAULT 'claude-sonnet-4-6',
    "thinking" TEXT NOT NULL DEFAULT 'adaptive',
    "maxOutputTokens" INTEGER NOT NULL DEFAULT 32000,
    "maxRetries" INTEGER NOT NULL DEFAULT 2,
    "requestTimeoutMs" INTEGER NOT NULL DEFAULT 120000,
    "maxToolCalls" INTEGER NOT NULL DEFAULT 24,
    "hardTimeoutMs" INTEGER NOT NULL DEFAULT 300000,
    "toolTimeoutMs" INTEGER NOT NULL DEFAULT 15000,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Config_pkey" PRIMARY KEY ("id")
);

