import type { Prisma } from "@prisma/client";

/**
 * The columns of `User` that may leave the server, in one place.
 *
 * This exists because of a real leak. `include: { user: true }` on a project's
 * assignments is the obvious thing to write and it returns the whole row —
 * which is how every scrypt hash on the team ended up in the JSON any signed-in
 * user got back from `GET /api/projects/:id`. The row now also carries a TOTP
 * secret and a set of recovery-code hashes, so the same mistake would hand over
 * both factors at once.
 *
 * **Never write `include: { user: true }`.** Use `select: PUBLIC_USER` (or
 * `NAMED_USER` where only the label is needed) so adding a sensitive column to
 * the model can never quietly widen an existing response.
 */
export const PUBLIC_USER = {
  id: true,
  name: true,
  email: true,
  role: true,
  skills: true,
  weeklyCapacityHours: true,
  active: true,
} satisfies Prisma.UserSelect;

/** For the many places that only need something to print next to a task or a time entry. */
export const NAMED_USER = { id: true, name: true } satisfies Prisma.UserSelect;
