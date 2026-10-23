# Doctor › Students — compact list (shipped)

The Doctor Students screen used to render one large neumorphic card per enrollment:
16 px padding, a 42 px avatar, five stacked text lines (name, contact, public id,
course, university / date / activation method) and a full-width three-button action
bar. One student measured roughly 130 px, so a phone screen showed three of them and
the list was mostly whitespace.

It is now a single compact, divider-separated list inside one hairline panel.

## Row anatomy (top to bottom, left to right)

| Element | Spec |
| --- | --- |
| Row | horizontal, `paddingHorizontal: 10`, `paddingVertical: 9`, `gap: 9`, hairline bottom divider (`c.text16`), no shadow/elevation |
| Selection | 18 px checkbox, only in Select mode; selected row gets a `c.primary10` tint |
| Avatar | 34 px circle — the real uploaded photo, initials fallback, `onError` fallback |
| Name | 13.5 px / 700, one line, ellipsized, full row width |
| Meta line | status pill (9 px / 800, tinted) · public id + copy icon (tap to copy) · course · progress % — one line, ellipsized |
| Actions | three 30 px icon buttons (Profile, Suspend/Resume, Remove), `hitSlop: 8`; hidden in Select mode |
| Row height | ~53–56 px (measured 53 px in the reconstruction) |

Tapping the row itself opens the student details sheet (in Select mode it toggles
selection). The details sheet still shows the large 76 px photo header.

## Toolbar and list chrome

- Add student / Create student: two compact 9 px chips instead of 14 px cards.
- Select toggle: 6 px pill; the selection bar and bulk actions are unchanged.
- Search: 9 px vertical padding, radius 12, 10 px below.
- Tabs: 7 px vertical padding, 6 px gap, 10 px below.
- By-course headers: 28 px badge, 10 px padding, list body without side padding.
- Lists: `listPanel` — one hairline-bordered, `overflow: hidden` panel; two columns
  from 700 px wide (each row still compact), one column on phones.

## Preserved behaviour

Search, all five tabs with counts, by-course groups + per-course select-all, Select
mode / select-all-visible / clear / bulk suspend|resume|remove with the same
authorization rules, details sheet, suspend / resume / remove, add-student (credits)
flow, pull-to-refresh, loading / empty / error / retry states, server-side visibility
filter, i18n (both locales), and the Super Admin / Admin English lock are untouched.

## Density

12 rows occupy ~636 px; the old layout needed ~1 560 px for the same 12 students.
A 390 × 844 phone shows roughly 9–10 students at once (header, toolbar and tabs take
the rest of the screen), versus 3 cards in the old layout.

`screenshots/doctor-students-compact-list-v2.png` (phone) and
`screenshots/doctor-students-compact-tablet.png` (two columns) are browser
reconstructions of the implemented geometry with placeholder students — the source
in `src/app/(app)/(doctor)/students.tsx` is the single source of truth.
