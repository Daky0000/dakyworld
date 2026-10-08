-- Repositories a person proved, through GitHub, that they reach with the app installed.
CREATE TABLE "GithubRepoClaim" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "installationId" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "defaultBranch" TEXT NOT NULL,
    "private" BOOLEAN NOT NULL,
    "githubLogin" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GithubRepoClaim_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GithubRepoClaim_userId_repositoryId_key" ON "GithubRepoClaim"("userId", "repositoryId");
CREATE INDEX "GithubRepoClaim_userId_idx" ON "GithubRepoClaim"("userId");

ALTER TABLE "GithubRepoClaim" ADD CONSTRAINT "GithubRepoClaim_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "GithubRepoClaim" ENABLE ROW LEVEL SECURITY;
