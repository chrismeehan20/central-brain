# Central Brain — design system

Recorded from the built world (src/client/src/index.css), 2026-08-21.
Direction: the category standard, played straight, at the craft bar of
Raycast (user decision — see PRODUCT.md). No themed metaphor; the finish IS
the design.

## Theme

Follows the OS via `prefers-color-scheme`; light is the authored default.
Every color routes through tokens on `:root` with a dark override block —
those two blocks are the entire difference between themes. Tints are always
`color-mix(in srgb, var(--token) N%, transparent)`, never literals.

## Tokens (roles, not values — values live in the CSS)

- Grounds: `--bg` (page), `--surface` (floating panels/cards),
  `--surface-raised` (controls ON a surface — darker than the card in
  light, lighter in dark), `--well` (recessed regions content floats in:
  board columns; never outlined).
- Lines: `--border` (structural), `--border-soft` (edge-crisping on
  floating cards; the shadow does the talking), `--border-strong`
  (scrollbars, strong hovers), `--hairline` (row separators).
- Ink: `--ink`, `--muted`. Accent: `--accent` (Mac-blue family in light,
  sky in dark; AA as text on its ground).
- Status: `--ok`, `--warn`, `--danger`, `--danger-pr`; tool identity
  `--claude`, `--codex`.
- Depth: `--shadow-card` / `--shadow-lift` (light: ambient+key layers;
  dark: none) and `--edge-highlight` (dark: lit top edge, `inset 0 1px 0`;
  light: none). Floating things compose `var(--edge-highlight),
  var(--shadow-card)`.

## Elevation grammar

Three layers: wells (recessed, `--well` fill, no border) hold floating
panels/cards (`--surface` + soft border + shadow/edge); controls sit on
cards as `--surface-raised` fills. Light elevates with shadow, dark with
the lit edge — same markup, token-swapped.

## Interaction language

- Hover is a FILL (`--hover` wash or a deeper surface), never a
  border-color trick. Active nav/filter states are tinted accent pills
  (`color-mix(accent 11-12%)` + accent text).
- Real controls press: `scale(0.98)` on `:active` (listed selectors, not
  global — text-like buttons stay still). 80–120ms ease transitions.
- One authored motion moment: each view rises 6px as it fades in on
  navigation (`view-in`, 200ms, cubic-bezier(0.2,0.9,0.3,1)), replayed
  only on remount. Status dots pulse from `currentColor`. All motion
  honors `prefers-reduced-motion`.

## Type

- `--font-ui`: the platform face — functional text, so the app reads as a
  Mac-native instrument.
- `--font-display`: Bricolage Grotesque (self-hosted variable, latin) —
  page titles and section headings ONLY.
- `--font-mono`: ui-monospace stack — branches, paths, codes. Counts and
  ages use `font-variant-numeric: tabular-nums`.

## Status vocabulary

waiting = `--danger` (pulsing dot, tinted row/chip, text says why);
active = `--ok` (pulsing dot, text "agent active");
idle = muted dot only, no words. Claude/Codex always carry their colors.

## Browser surfaces

Selection, caret, thin scrollbars, and `:focus-visible` rings are themed
from the palette. Icons are drawn SVGs (lucide-style line art plus the
orbit brand mark) — never unicode glyphs.
