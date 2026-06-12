-- AlterTable
ALTER TABLE "Config" ADD COLUMN     "apiKeyEncrypted" TEXT,
ADD COLUMN     "baseUrl" TEXT,
ADD COLUMN     "promptCaching" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "reasoningEffort" TEXT;
