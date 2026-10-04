# DakyXTech product architecture

## Domain ownership

- `dakyx.com`: public company and product marketing
- `app.dakyx.com`: customer account, organization, billing, and product launcher
- `os.dakyx.com`: staff-only company operations
- `editor.dakyx.com`: customer Website Editor after server-side isolation is complete

Features remain routes inside their owning product. Databases, Redis, queues, workers, and private APIs receive no public DNS names.

## Deployment ownership

The current Railway project becomes the logical `dakyx-os` project. It owns OS API, OS worker, OS PostgreSQL, and OS Redis. Resource renames are optional and must not break references.

Future customer workspace and editor products use separate Railway projects when their code and data boundaries are ready. Core owns identity, organizations, billing ownership, and entitlements. Product databases own product records. Products use short-lived signed SSO handoffs and local sessions rather than calling Core on every request.

## Data boundaries

- Core: user identity, organizations, membership, subscriptions, entitlements, security state
- OS: leads, proposals, projects, invoices, internal agents, staff workflows
- Editor: sites, pages, drafts, assets, publications, collaborators, editor audit history

No product reads another product database directly. Cross-product changes use versioned APIs or events with stable IDs and idempotency keys.
