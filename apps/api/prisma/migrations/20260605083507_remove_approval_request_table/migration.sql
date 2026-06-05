-- DropForeignKey
ALTER TABLE "ApprovalRequest" DROP CONSTRAINT "ApprovalRequest_installationId_fkey";

-- DropTable
DROP TABLE "ApprovalRequest";
