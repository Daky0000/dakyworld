# ADR 0001: Preserve the existing website source

Status: accepted (records the existing design).

The editor serves teams maintaining independently developed HTML websites. Rebuilding each page into a proprietary document model would replace formatting, scripts and structure that the editor does not own.

Edits therefore target discovered or explicitly annotated fields. Drafts store values and conflict anchors. Publishing validates the latest source and changes only affected spans. Responsive and interaction styles use generated, identifiable style blocks so they survive export and repository publication. Brand presets are stored in site settings and applied explicitly to reviewed pages.

This preserves compatibility and readable repository diffs. It also limits arbitrary layout generation, requires source-conflict handling and means presets are explicit applications rather than continuously linked design tokens. AI returns validated field proposals and follows the same draft and publish path.
