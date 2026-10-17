# Backtrack design system (tokens and rules)

Source of truth for `apps/web`. The generated proposal in `design-system/backtrack/MASTER.md` (UI/UX Pro Max) is the baseline; this file records the decisions that override it.

## Direction
A dark control room for engineers who operate agents. Calm surfaces, precise type, one accent. Color carries meaning, never decoration: blue = selected / changed, amber = pending / needs approval, red = irreversible, green = reverted. Everything else is neutral.

## Tokens (CSS variables in `apps/web/app/globals.css`; dark is default, light supported via the same names)
| Token | Dark | Role |
|---|---|---|
| `--bg` | `#070B14` | page background |
| `--surface` | `#0E1424` | panels, cards |
| `--surface-2` | `#141C30` | nested cards, hover |
| `--border` | `#243049` | hairlines |
| `--fg` | `#EEF2F8` | primary text |
| `--fg-muted` | `#93A1B8` | secondary text, labels |
| `--accent` | `#4C8DFF` | selection, links, changed-field flash, dependency particles |
| `--amber` | `#F5B544` | pending status ring, approval card |
| `--red` | `#F0564A` | irreversible actions, denied, conflict |
| `--green` | `#3ECF8E` | reverted / restored flash, success |
| `--teal` | `#2FB8C6` | create-type actions in the graph |
| `--grey-node` | `#5B6B85` | read-only actions, undone (dashed) |
| `--ring` | `#4C8DFF` | focus ring (2 px, offset 2 px) |

Contrast: all text on `--bg`/`--surface` ≥ 4.5:1; `--fg-muted` is the minimum for body text, never for small labels under 12 px.

## Typography
- Text: **Inter** (400/500/600). Body 14 px / 1.5; labels 12 px / 1.4 with normal case (no all-caps).
- Code, ids, Cypher, numbers in tables: **JetBrains Mono** (400/500), 13 px.
- One scale: 12 / 13 / 14 / 16 / 20 / 28. Headlines are sentence case; no single-word color accents inside headlines.

## Layout
Top bar 56 px. Three columns 40 / 35 / 25 on ≥ 1280 px; 50 / 50 with the world panel as a drawer on 1024–1279; stacked on < 1024 (graph first). 16 px gutters, 12 px card padding, 8 px radius, 1 px borders instead of shadows.

## Components (shadcn/ui base)
Button (primary = accent fill, secondary = surface-2, destructive = red outline), Card, Badge (status), Sheet (explain drawer), Slider (depth, scrubber), Tooltip, Tabs (world sections), Toast (errors with the real message). Icons: Lucide only, never emoji.

## Motion
- One animation per change, 200–400 ms, `cubic-bezier(0.2, 0.8, 0.2, 1)`.
- Allowed loops: the pending pulse (amber ring, 1.2 s) only.
- Graph: nodes spring in; selected subgraph particles flow along `DEPENDS_ON` edges toward the dependency; unselected dims to 20 % opacity.
- World panel: field change flashes `--accent` background for 600 ms; revert flashes `--green` and shows "restored" for 2 s; creates slide in 240 ms; deletes collapse 200 ms.
- Undo execution paced at ~500 ms per step so the audience can follow.
- `prefers-reduced-motion`: no particles, no pulse, instant state changes.

## Copy
Sentence case. Every count or ordering on screen is traceable: the trace strip or drawer shows the Cypher. Error toasts show the real message. Empty state: "Nothing recorded yet. Run the ops agent."

## Graph encoding
Action = circle, color by tool family (read `--grey-node`, write `--accent`, create `--teal`, external `--red`); status ring: done solid, pending pulsing amber, undone dashed grey, blocked/denied red. Entity = diamond with label. Agents = colored hull/label. `DEPENDS_ON` thick with arrowhead; `CAUSED`/`ON` thin.
