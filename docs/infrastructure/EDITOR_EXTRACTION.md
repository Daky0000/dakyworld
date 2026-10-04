# Website Editor extraction

## Current boundary

The Website Editor shares the OS Express server, Prisma schema, authentication, React client, publishing services, GitHub App integration, R2 storage, queues, and internal navigation. A subdomain alone would not isolate customer users from internal OS functionality.

## Required boundary before `editor.dakyx.com`

1. Inventory editor routes, models, jobs, assets, and publishing commands.
2. Define editor-owned records and shared identity identifiers.
3. Enforce an editor-only server surface and deny internal OS routes regardless of client navigation.
4. Add organization/site authorization to every editor command.
5. Replace route-to-route and worker-to-Express calls with typed application commands.
6. Add tests proving editor users cannot access leads, invoices, internal agents, settings, or company operations.
7. Design a copy-first data migration with counts, referential checks, stable ID mappings, rollback, and retained source data.
8. Create a separate Railway project and database only after those gates pass.

## Shared services

Use central identity and entitlement assertions with short-lived signed tokens. Keep editor sessions local. Keep editor drafts, assets, publications, collaborators, and audit history in the editor database. Use R2 with product-scoped paths and credentials.
