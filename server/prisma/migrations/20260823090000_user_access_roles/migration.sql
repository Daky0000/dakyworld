-- Roles you can create, and features you can hand out one at a time.
--
-- Before this, "what may this person do" was `requireRole("OWNER", …)` written
-- into twenty routers and a matching list in the client's nav. Changing it
-- meant a code change and a deploy, and the six roles that existed were the
-- only six there could ever be.
--
-- Deliberately NOT in this file: the six system roles themselves, and the
-- backfill that puts existing accounts onto them. Those live in
-- `ensureSystemRoles()` (server/src/lib/accessRoles.ts), which runs at boot
-- before the server accepts a request. The reason is that the permission lists
-- belong to lib/permissions.ts and copying them into SQL would mean two
-- sources of truth for the same grant — and the moment somebody edits a system
-- role from the Access screen, the SQL copy becomes a lie that the next
-- migration replay would reinstate.
--
-- The consequence to know: between this migration running and the process
-- booting, every user has `accessRoleId = NULL`, which is *no access at all*.
-- That window is inside a deploy, not inside a running system, and failing
-- closed is the right way round for it to fail.

CREATE TABLE "AccessRole" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "system" BOOLEAN NOT NULL DEFAULT false,
    "superAdmin" BOOLEAN NOT NULL DEFAULT false,
    "external" BOOLEAN NOT NULL DEFAULT false,
    "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sortOrder" INTEGER NOT NULL DEFAULT 100,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccessRole_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AccessRole_key_key" ON "AccessRole"("key");
CREATE INDEX "AccessRole_sortOrder_idx" ON "AccessRole"("sortOrder");

ALTER TABLE "User"
    ADD COLUMN "accessRoleId" TEXT,
    ADD COLUMN "extraPermissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN "deniedPermissions" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- SET NULL rather than CASCADE or RESTRICT. Deleting a role must never delete
-- the people who held it, and it must never be blocked by them either — the
-- Access screen reassigns before it deletes, and this is the backstop for the
-- case where it doesn't. A user with no role has no permissions, which is the
-- safe end of that failure.
ALTER TABLE "User"
    ADD CONSTRAINT "User_accessRoleId_fkey"
    FOREIGN KEY ("accessRoleId") REFERENCES "AccessRole"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Same posture as every other table here: any role other than the one the
-- application connects as reads zero rows. See 20260819180100_row_level_security
-- for why this is enabled but not forced.
ALTER TABLE "AccessRole" ENABLE ROW LEVEL SECURITY;
