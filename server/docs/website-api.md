# Website API reference

Base path: `/api/website`. Requests require the existing session and per-site capability checks. Writes use JSON. Errors use `{ "error": "message" }`; 403 means insufficient access, 409 means stale revision/source, 422 means invalid change, and 429 includes `Retry-After`. The global API ceiling is 600 requests/minute per IP; expensive website actions additionally allow 20/minute per user per server process.

## Editing contract

`GET /pages/:pageId` returns fields, sections, draft values and revision, source metadata and problems. `PUT /pages/:pageId/draft` accepts values and `ifRevision`; preserve documentHash and sharedRevisions returned by the editor when relevant. Field edits support value, href, alt, style, responsive, variant and newTab. The server derives conflict anchors; do not write source offsets.

`GET /pages/:pageId/review` returns before/after summaries, conflicts and publishability. `POST /pages/:pageId/publish` accepts the reviewed `ifRevision` and `sourceHash`. Publish follows the existing asynchronous job and verification flow. `DELETE /pages/:pageId/draft?ifRevision=N` discards unpublished values, not the public page.

`POST /pages/:pageId/assistant` accepts prompt, selectedFieldId and current values. It returns a validated proposal with explanation, values and before/after changes. It does not save. `POST /pages/:pageId/assistant/preview` accepts selectedFieldId and merged values and returns a static HTML preview; render it in a sandbox without script or same-origin privileges. Approval uses the ordinary draft endpoint.

`GET /sites/:siteId/audit` returns the latest 100 activity events, newest first. Brand presets persist in `Site.settings.presets` through existing settings endpoints; no additional brand model is required.

## Route index

The table identifies the registration source. Consult its Zod schemas for exact request fields and the access service for capability mapping. Parameters beginning with `:` are path parameters.

| Method | Path | Registration source |
| --- | --- | --- |
| GET | `/overview` | `website.ts` |
| GET | `/pages/:pageId` | `website.ts` |
| PATCH | `/pages/:pageId` | `website.ts` |
| POST | `/pages/:pageId/assistant` | `websiteAssistant.ts` |
| POST | `/pages/:pageId/assistant/preview` | `websiteAssistant.ts` |
| DELETE | `/pages/:pageId/draft` | `website.ts` |
| PUT | `/pages/:pageId/draft` | `website.ts` |
| GET | `/pages/:pageId/export` | `websiteManagement.ts` |
| GET | `/pages/:pageId/preview` | `website.ts` |
| POST | `/pages/:pageId/publish` | `website.ts` |
| GET | `/pages/:pageId/review` | `websiteManagement.ts` |
| POST | `/pages/:pageId/structure` | `website.ts` |
| GET | `/pages/:pageId/versions` | `website.ts` |
| GET | `/pages/:pageId/versions/:versionId/diff` | `website.ts` |
| POST | `/pages/:pageId/versions/:versionId/publish` | `website.ts` |
| POST | `/pages/:pageId/versions/:versionId/restore` | `website.ts` |
| DELETE | `/shared/:sharedId` | `websiteShared.ts` |
| GET | `/shared/:sharedId` | `websiteShared.ts` |
| DELETE | `/shared/:sharedId/draft` | `websiteShared.ts` |
| PUT | `/shared/:sharedId/draft` | `websiteShared.ts` |
| POST | `/shared/:sharedId/instances/:instanceId/detach` | `websiteShared.ts` |
| POST | `/shared/:sharedId/instances/:instanceId/relink` | `websiteShared.ts` |
| POST | `/shared/:sharedId/publish` | `websiteShared.ts` |
| GET | `/shared/:sharedId/review` | `websiteShared.ts` |
| GET | `/sites` | `website.ts` |
| POST | `/sites` | `websiteManagement.ts` |
| PATCH | `/sites/:siteId` | `website.ts` |
| GET | `/sites/:siteId/access` | `websiteAccess.ts` |
| GET | `/sites/:siteId/assets` | `websiteManagement.ts` |
| POST | `/sites/:siteId/assets` | `websiteManagement.ts` |
| GET | `/sites/:siteId/assets/:assetId/content` | `websiteManagement.ts` |
| GET | `/sites/:siteId/audit` | `websiteManagement.ts` |
| GET | `/sites/:siteId/compatibility` | `websiteReadiness.ts` |
| GET | `/sites/:siteId/config` | `websiteManagement.ts` |
| PUT | `/sites/:siteId/config` | `websiteManagement.ts` |
| GET | `/sites/:siteId/design` | `websiteManagement.ts` |
| POST | `/sites/:siteId/import` | `websiteManagement.ts` |
| GET | `/sites/:siteId/members` | `websiteAccess.ts` |
| POST | `/sites/:siteId/members` | `websiteAccess.ts` |
| DELETE | `/sites/:siteId/members/:memberId` | `websiteAccess.ts` |
| PATCH | `/sites/:siteId/members/:memberId` | `websiteAccess.ts` |
| GET | `/sites/:siteId/onboarding` | `websiteOnboarding.ts` |
| POST | `/sites/:siteId/onboarding/handover` | `websiteOnboarding.ts` |
| GET | `/sites/:siteId/pages` | `website.ts` |
| GET | `/sites/:siteId/publish-jobs` | `websitePublishJobs.ts` |
| GET | `/sites/:siteId/publish-jobs/:jobId` | `websitePublishJobs.ts` |
| POST | `/sites/:siteId/scan` | `website.ts` |
| GET | `/sites/:siteId/shared` | `websiteShared.ts` |
| POST | `/sites/:siteId/shared` | `websiteShared.ts` |
| GET | `/sites/:siteId/shared/suggestions` | `websiteShared.ts` |
| GET | `/sites/:siteId/source` | `websiteSource.ts` |
| POST | `/sites/:siteId/source/export` | `websiteSource.ts` |
| GET | `/sites/:siteId/source/files` | `websiteSource.ts` |
| POST | `/sites/:siteId/source/preview` | `websiteSource.ts` |
| POST | `/sites/:siteId/source/publish` | `websiteSource.ts` |
| POST | `/sites/:siteId/source/review` | `websiteSource.ts` |
