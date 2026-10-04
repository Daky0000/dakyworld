# DakyXTech Railway Infrastructure as Code (IaC)

This directory defines the infrastructure configuration for Railway services, databases, volumes, environments, and domain routing.

## Services Architecture

- **`dakyworld` (API Service)**:
  - Role: `SERVICE_ROLE=api`
  - Start command: `npm run start:api`
  - Health check: `/api/ready`
  - Domains:
    - `os.dakyx.com` (DakyXTech internal company OS)
    - `editor.dakyx.com` (Website Editor surface)
    - `app.dakyx.com` (Customer Workspace & Product Launcher)
    - `os.dakyworld.com` (Legacy domain)

- **`worker` (Background Worker Service)**:
  - Role: `SERVICE_ROLE=worker`
  - Start command: `npm run start:worker`
  - Runs queue workers, scheduled tasks, and media migrations.
  - No public domain attached.

- **`Postgres` (Database)**:
  - Image: `ghcr.io/railwayapp-templates/postgres-ssl:18`
  - Persistent volume: `postgres-volume` mounted at `/var/lib/postgresql/data` (5 GB)
  - Private Railway networking only.

- **`redis` (Cache & Admission Control)**:
  - Image: `redis:8-alpine`
  - Private networking.

## Environments

- `production`: Live workload serving customers and operations.
- `staging`: Isolated staging environment with separate PostgreSQL and Redis instances.
