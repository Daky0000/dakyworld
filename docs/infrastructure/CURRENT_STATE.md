# DakyXTech infrastructure current state

Last verified: 2026-10-04.

## GitHub

- Repository: `Daky0000/dakyworld`
- Default and production branch: `main`
- Marketing site: repository root, published with GitHub Pages
- Internal OS: `server/`, deployed to Railway
- GitHub Pages still uses `dakyworld.com` until `dakyx.com` DNS is available and verified.

## Railway production

- Project: `discerning-recreation` (`9b8234d5-ae2e-4576-b96d-8ae2f53c3b42`)
- Environment: `production` (`528cacfc-99ae-43e4-aa94-dd12241b8e69`)
- OS service: `dakyworld` (`251ee1f3-c169-47f8-828a-589dfd5ddc68`)
- PostgreSQL: `Postgres` (`9c52b82d-b813-4432-ba89-88969d3c1ad2`)
- Region: `us-west2`
- Source: `Daky0000/dakyworld`, branch `main`, root `/server`
- Legacy production domain: `os.dakyworld.com`, port `8080`
- Object storage: Cloudflare R2; no Railway bucket
- Redis: not provisioned
- Dedicated worker: not provisioned
- Staging: not provisioned

Production PostgreSQL uses a persistent 5 GB volume. Its connection is private Railway networking. Secret values are intentionally omitted.

## Domain blocker

`dakyx.com` resolves through Hostinger nameservers, but the connected Hostinger API account reports that it does not own the domain. Do not replace the GitHub Pages `CNAME`, remove legacy DNS, or switch application origins until the correct Hostinger account is connected and the new hostnames pass HTTPS checks.

## Known security follow-up

Railway logs report a weak `OWNER_PASSWORD` and a deployed `DEV_NO_AUTH` variable. Login remains enforced because production ignores `DEV_NO_AUTH`, but both variables require deliberate credential/configuration cleanup.
