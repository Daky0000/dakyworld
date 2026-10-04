/**
 * DakyXTech Railway Infrastructure as Code (IaC)
 * 
 * Defines the production and staging infrastructure topology for DakyXTech:
 * - dakyx-os API service (Express/React, port 8080)
 * - dakyx-os Worker service (Background jobs, scheduler)
 * - PostgreSQL service with persistent volume
 * - Redis service for job admission and cache
 * - Multi-domain mapping: os.dakyx.com, editor.dakyx.com, app.dakyx.com
 */

export interface ServiceConfig {
  name: string;
  source: {
    repo: string;
    branch: string;
    rootDirectory: string;
  } | {
    image: string;
  };
  variables: Record<string, string>;
  volumes?: Array<{
    name: string;
    mountPath: string;
    sizeMb: number;
  }>;
  domains?: Array<{
    domain: string;
    targetPort?: number;
  }>;
  healthcheckPath?: string;
  buildCommand?: string;
  startCommand?: string;
  region?: string;
}

export interface RailwayProjectConfig {
  id: string;
  name: string;
  defaultRegion: string;
  environments: {
    production: {
      id: string;
      services: Record<string, ServiceConfig>;
    };
    staging: {
      id: string;
      services: Record<string, ServiceConfig>;
    };
  };
}

export const config: RailwayProjectConfig = {
  id: "9b8234d5-ae2e-4576-b96d-8ae2f53c3b42",
  name: "discerning-recreation", // Logical target: dakyx-os
  defaultRegion: "us-west2",
  environments: {
    production: {
      id: "528cacfc-99ae-43e4-aa94-dd12241b8e69",
      services: {
        api: {
          name: "dakyworld",
          source: {
            repo: "Daky0000/dakyworld",
            branch: "main",
            rootDirectory: "/server",
          },
          healthcheckPath: "/api/ready",
          buildCommand: "npm run build",
          startCommand: "npm run start:api",
          region: "us-west2",
          domains: [
            { domain: "os.dakyx.com", targetPort: 8080 },
            { domain: "editor.dakyx.com", targetPort: 8080 },
            { domain: "app.dakyx.com", targetPort: 8080 },
            { domain: "os.dakyworld.com", targetPort: 8080 },
          ],
          variables: {
            PORT: "8080",
            NODE_ENV: "production",
            SERVICE_ROLE: "api",
            DATABASE_URL: "${{Postgres.DATABASE_URL}}",
            REDIS_URL: "${{redis.REDIS_URL}}",
            APP_URL: "https://os.dakyx.com",
            CLIENT_ORIGIN: "https://os.dakyx.com,https://editor.dakyx.com,https://app.dakyx.com",
            RESPONSE_CACHE_ENABLED: "true",
            JOB_ADMISSION_ENABLED: "true",
          },
        },
        worker: {
          name: "worker",
          source: {
            repo: "Daky0000/dakyworld",
            branch: "main",
            rootDirectory: "/server",
          },
          startCommand: "npm run start:worker",
          region: "us-west2",
          variables: {
            NODE_ENV: "production",
            SERVICE_ROLE: "worker",
            DATABASE_URL: "${{Postgres.DATABASE_URL}}",
            REDIS_URL: "${{redis.REDIS_URL}}",
            APP_URL: "https://os.dakyx.com",
          },
        },
        postgres: {
          name: "Postgres",
          source: {
            image: "ghcr.io/railwayapp-templates/postgres-ssl:18",
          },
          region: "us-west2",
          volumes: [
            {
              name: "postgres-volume",
              mountPath: "/var/lib/postgresql/data",
              sizeMb: 5000,
            },
          ],
          variables: {
            POSTGRES_DB: "railway",
            POSTGRES_USER: "postgres",
          },
        },
        redis: {
          name: "redis",
          source: {
            image: "redis:8-alpine",
          },
          region: "us-west2",
          variables: {},
        },
      },
    },
    staging: {
      id: "b8a2bf9e-c93e-4e39-a11a-0e6a81cf1ed8",
      services: {
        api: {
          name: "dakyworld",
          source: {
            repo: "Daky0000/dakyworld",
            branch: "main",
            rootDirectory: "/server",
          },
          healthcheckPath: "/api/ready",
          buildCommand: "npm run build",
          startCommand: "npm run start:api",
          region: "us-west2",
          variables: {
            PORT: "8080",
            NODE_ENV: "production",
            SERVICE_ROLE: "api",
            DATABASE_URL: "${{Postgres.DATABASE_URL}}",
            REDIS_URL: "${{redis.REDIS_URL}}",
          },
        },
        worker: {
          name: "worker",
          source: {
            repo: "Daky0000/dakyworld",
            branch: "main",
            rootDirectory: "/server",
          },
          startCommand: "npm run start:worker",
          region: "us-west2",
          variables: {
            NODE_ENV: "production",
            SERVICE_ROLE: "worker",
            DATABASE_URL: "${{Postgres.DATABASE_URL}}",
            REDIS_URL: "${{redis.REDIS_URL}}",
          },
        },
        postgres: {
          name: "Postgres",
          source: {
            image: "ghcr.io/railwayapp-templates/postgres-ssl:18",
          },
          region: "us-west2",
          volumes: [
            {
              name: "postgres-volume-staging",
              mountPath: "/var/lib/postgresql/data",
              sizeMb: 5000,
            },
          ],
          variables: {
            POSTGRES_DB: "railway",
            POSTGRES_USER: "postgres",
          },
        },
        redis: {
          name: "redis",
          source: {
            image: "redis:8-alpine",
          },
          region: "us-west2",
          variables: {},
        },
      },
    },
  },
};

export default config;
