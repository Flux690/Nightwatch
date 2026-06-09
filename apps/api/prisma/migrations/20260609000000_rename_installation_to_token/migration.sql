-- RenameTable
ALTER TABLE "Installation" RENAME TO "Token";

-- Rename the constraints and index so they match the new model name; renaming
-- the table alone leaves Postgres holding the old Installation_* identifiers.
ALTER TABLE "Token" RENAME CONSTRAINT "Installation_pkey" TO "Token_pkey";
ALTER TABLE "Token" RENAME CONSTRAINT "Installation_userId_fkey" TO "Token_userId_fkey";
ALTER INDEX "Installation_token_key" RENAME TO "Token_token_key";
