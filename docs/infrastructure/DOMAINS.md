# DakyXTech domains

## Intended production map

| Hostname | Owner | Status |
| --- | --- | --- |
| `dakyx.com` | GitHub Pages marketing site | DNS active; HTTPS certificate provisioning |
| `www.dakyx.com` | Alias to marketing site | DNS active; HTTPS certificate provisioning |
| `os.dakyx.com` | Existing Railway OS service | Attached; HTTPS certificate provisioning |
| `app.dakyx.com` | Future customer workspace | Not built |
| `editor.dakyx.com` | Future isolated editor | Boundary not safe yet |
| `dakyworld.com` | Legacy hostname | Permanent redirect requested in Hostinger |
| `os.dakyworld.com` | Legacy Railway OS domain | Keep active |

## Cutover order

1. Restore and verify the existing OS.
2. Back up PostgreSQL and export DNS.
3. Attach `os.dakyx.com` to the existing Railway service.
4. Add only Railway-required DNS records in the authoritative `dakyx.com` zone.
5. Wait for ownership verification and TLS issuance.
6. Change `APP_URL` and `CLIENT_ORIGIN` to `https://os.dakyx.com`.
7. Verify login, protected routes, forms, callbacks, and `/api/ready`.
8. Keep `os.dakyworld.com` active during the transition.
9. Change GitHub Pages to `dakyx.com` only after apex and `www` DNS are ready.
10. Add permanent legacy redirects only after all integrations use DakyXTech hostnames.

Never modify MX, SPF, DKIM, or DMARC records as part of this application-domain migration.
