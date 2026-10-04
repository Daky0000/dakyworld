# DakyXTech domains

## Production domain topology

| Hostname | Owner | Status | Target / Port |
| --- | --- | --- | --- |
| `dakyx.com` | GitHub Pages marketing site | Active over HTTPS (200 OK) | GitHub Pages A / AAAA |
| `www.dakyx.com` | Alias to marketing site | Active over HTTPS (200 OK) | CNAME `daky0000.github.io` |
| `os.dakyx.com` | DakyXTech Company OS (Railway) | Active over HTTPS (200 OK) | CNAME `m490k52o.up.railway.app` (Port 8080) |
| `app.dakyx.com` | Customer Workspace & Product Launcher | Attached in Railway | CNAME `0kg4s78c.up.railway.app` (Port 8080) |
| `editor.dakyx.com` | Standalone Website Editor Product | Attached in Railway | CNAME `pf5fc5xw.up.railway.app` (Port 8080) |
| `os.dakyworld.com` | Legacy Railway OS domain | Maintained for staff continuity | Port 8080 |

## Architecture policy

- **Direct Native Domain**: All DakyXTech customer and operations software run directly and natively on `*.dakyx.com`. No legacy domain redirects or external URL forwarders are required.
- **Surface Isolation**:
  - `editor.dakyx.com`: Exclusively serves the Website Editor, site management, asset library, and publishing pipeline. All internal company operations, leads, proposals, invoices, and agent configs return 404.
  - `app.dakyx.com`: Exclusively serves the Central Customer Workspace, organization/account management, and multi-product launcher (Website Editor, Automations, Analytics).
  - `os.dakyx.com`: Serves the internal DakyXTech company operating system for staff operations.
- **DNS Records Required for New Product Subdomains**:
  - `editor.dakyx.com`: CNAME `pf5fc5xw.up.railway.app`
  - `app.dakyx.com`: CNAME `0kg4s78c.up.railway.app`

Never modify MX, SPF, DKIM, or DMARC records as part of this application-domain migration.
