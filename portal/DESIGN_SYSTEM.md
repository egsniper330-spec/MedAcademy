# MedAcademy Neumorphic Design System

The portal uses one visual layer on top of the existing structural CSS:

- `src/index.css` — original layout primitives, retained so no page markup breaks.
- `src/styles/neumorphic.css` — design tokens, shell, components, page states, responsive and RTL rules.

`src/main.tsx` loads the new layer after `index.css`, so every existing route inherits the redesign without changing API or authentication code.

## Design tokens

All tokens live on `:root` in `src/styles/neumorphic.css`.

| Token | Purpose |
| --- | --- |
| `--neu-base` | Foundation surface (`#e9edf4`). |
| `--background`, `--surface`, `--surface-2` | Page, raised and sunken surfaces. |
| `--foreground`, `--muted`, `--muted-soft` | Text hierarchy. |
| `--primary`, `--primary-soft`, `--primary-ring` | Accent, tint and keyboard focus. |
| `--success`, `--warning`, `--danger`, `--violet` | Status colours with matching soft backgrounds. |
| `--shadow-neu-flat` | Raised card/button shadow. |
| `--shadow-neu-pressed` | Recessed input/active navigation shadow. |
| `--shadow-neu-small` | Restrained shadow for dense controls. |
| `--shadow-float` | Modals, dropdowns and the mobile drawer. |
| `--radius`, `--radius-sm`, `--radius-lg` | 18 / 12 / 24 px geometry. |
| `--ease`, `--duration` | Shared damped easing and 280 ms transition. |

Typography is locally hosted. `GlowSansSC-Latin.woff2` is the subsetted Latin face; `NotoSansArabic-Regular.woff2` supplies Arabic glyphs and shaping. Arabic pages switch to the Arabic-first stack through `[dir='rtl']`.

## Surfaces and controls

The visual language is applied through shared component classes:

- `.card`, `.stat-card`, `.cms-card`, `.notification-card` — raised floating surfaces.
- `.nav-link.active`, `.tabs button.active`, `.segmented` — pressed/selected states.
- `.btn`, `.btn-primary`, `.btn-danger`, `.btn-ghost`, `.icon-btn` — tactile actions with pressed feedback.
- `.field input`, `.field select`, `.field textarea`, `.toolbar-search` — recessed inputs with a soft focus ring.
- `.table-wrap` — restrained table surface; rows use borders and hover tint rather than a shadow per cell.
- `.modal`, `.user-popover`, `.topbar-search-results`, `.toast` — elevated overlays using `--shadow-float`.

No page-specific colour or shadow values are required. New controls should reuse these classes.

## Shell

`src/components/AppLayout.tsx` provides:

- Floating raised sidebar with grouped, role-filtered navigation and a recessed active item.
- Sticky soft top bar with page search, notifications, EN/AR switch and profile menu.
- Breadcrumbs supplied by `PageHeader` in `src/components/ui.tsx`.
- Mobile drawer with scrim, close button and 44 px touch targets.

Page search reads the same role-filtered navigation list as the sidebar. It never exposes routes the current role cannot access.

## Dark mode architecture

`[data-theme='dark']` redefines every surface, text, status and shadow token with a dedicated dark neumorphic palette. Components do not need rewriting. No theme switch is exposed because the current portal has no theme preference contract.

## Responsive behaviour

- `> 1240px`: full sidebar, three-column admin statistics, multi-column page grids.
- `1024–1240px`: narrower sidebar, compressed statistics and search.
- `≤ 1024px`: off-canvas drawer, single-column dashboards, scrollable wide tables.
- `≤ 760px`: compact top bar, two-column statistics, stacked forms, trimmed high-density table columns.
- `≤ 480px`: single-column statistics and tighter page gutters.
- RTL mirrors the shell, drawer direction, navigation hover motion, table alignment and form spacing.

## Accessibility

- Visible `:focus-visible` ring on every interactive element.
- Text and muted text meet contrast targets against the foundation surface.
- Buttons and icon buttons have accessible labels; the current page is marked with `aria-current`.
- Search exposes a labelled input and a menu of results.
- Modals use `role="dialog"`, `aria-modal`, labelled titles and Escape/backdrop close.
- `prefers-reduced-motion: reduce` removes transforms, transitions and entry animations.
- Disabled controls retain a distinguishable surface and cursor state.

## Visual verification assets

`portal/screenshots/` contains desktop, tablet, mobile, RTL and modal captures used during implementation review. They were produced with local visual fixtures for protected pages; the shipped application always uses the live API.
