# Doctor course card — compact redesign proposal

**Status: awaiting approval. The shipped course list is unchanged.**

The production card in `src/app/(app)/(doctor)/courses.tsx` is still the tall
thumbnail + description + meta + tags + "Edit ›" card. This document and the
screen at `/course-card-preview` are the proposal only.

## How to view it

1. Run the app in development (`npm run web` / `npm start`).
2. Sign in as a **doctor** and open **My Courses**.
3. Tap the eye icon in the header (development builds only — the button is
   compiled out when `__DEV__` is false).
   Or open `/course-card-preview` with a deep link in a dev build.
4. Use the in-page **العربية / English** and **Wide / Narrow** toggles.

Outside a development build the route renders a short "this preview is only
available in development builds" message instead of the proposal.

## What changes

| | Current card | Proposed card |
|---|---|---|
| Height per course | ~300–340 dp (16:9 thumbnail, description, tags, CTA) | ~84 dp (56–64 dp thumbnail + 2 text lines) |
| Courses visible per phone screen | 1–1.5 | 4–5 |
| Wide layout | single column | two-column grid ≥ 700 dp |
| Actions | always-visible "Edit ›" + ⋮ menu | single ⋮ that expands the same actions inline |
| Metadata | separate rows per field | one wrapping meta line |

## What is preserved (nothing is dropped)

- Thumbnail with the existing category fallback.
- Title (2 lines, so long/Arabic titles wrap instead of clipping).
- Status pill for **published / draft / hidden / archived**.
- Lesson count, student count, section count, duration, difficulty, first two
  tags.
- Archived badge and reduced emphasis.
- **All four actions**: Edit, Preview as student, Duplicate, Delete.
- Localized status names and the RTL-safe layout (`gap`, no physical margins,
  chevrons pointing along the reading direction).

## Why the compaction is safe

The old card showed the short description and every tag. Those are still
available on the course editor and in the proposal's meta line for the first two
tags. If a reviewer wants the short description kept on the card, the proposal
can grow to ~104 dp by adding it as a second muted line — still less than a
third of the current height.

## Approval checklist

- [ ] Approved as-is
- [ ] Keep the short description line
- [ ] Show more tags
- [ ] Keep the explicit "Edit" CTA instead of the ⋮ menu
- [ ] Other changes: ______________________

Until approved, the proposal stays isolated in `(hubs)/course-card-preview.tsx`
and the production list keeps its current design.
