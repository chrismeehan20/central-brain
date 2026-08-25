# Central Brain — product truth

## Users and job

One person: a solo builder who runs many AI-agent-driven projects at once
(Claude Code and Codex sessions across repos), on a Mac, during the workday.
The dashboard is glanced at between coding sessions — from the menubar
popover or a browser tab — to answer three questions fast: which agent needs
me right now, what is every agent doing, and what should run next. Sessions
are resumed with one click into the exact chat. (Evidence: README, session
history; confirmed in use.)

## Mechanism and position

Local-first mission control. Auto-discovers projects from the tools' own
session stores (`~/.claude/projects`, `~/.codex/sessions`), receives push
alerts from editor hooks the moment an agent blocks on a permission or goes
idle waiting, and links the real markdown files in each repo. No SaaS, no
external server, plain JSON files on disk. The differentiated position:
it tells you the moment an agent is blocked on you — attention, not
analytics.

## Surfaces

Overview (project grid + attention inbox), Mission Control (cross-project
kanban with live agent state), Agents (session roster), Activity (hook event
stream), per-project detail. All Operate-mode surfaces.

## Platform

`web` — a React SPA served by the local server, viewed in a Tauri menubar
popover and in the browser. macOS-first.

## Durable constraints

- Runs entirely offline: every asset self-hosted, no CDN or network fonts.
- Theme follows the OS: light is the authored default, dark must remain
  fully supported (user decision, 2026-08-21).
- Desktop-first but must degrade to a ~700px popover width.
- Metadata-only privacy rule: the UI may show event names, tool names,
  branches, paths — never prompts or tool inputs.

## Brand commitments

- Name: Central Brain. Mark: a core with an agent in orbit (drawn SVG).
- Type (user-selected, 2026-08-21): the platform UI face for functional
  text; Bricolage Grotesque (self-hosted variable) for display. A future
  visual world may propose changes, but replacement needs user approval.
- Tool identities: Claude and Codex each keep a recognizable color.

## Standing visual preference (user decision, 2026-08-21)

Offered a direction round (dice-assigned "control surface" world, a
flight-strip alternative, and the standing exit), the user chose the
standing exit: **the category standard, played straight, at full craft** —
no themed metaphor, no smuggled quirk. The named craft bar is **Raycast**:
soft layered depth, luminous panels, wash-fill hover language, tactile
press states, restrained-but-confident accent, fast micro-motion. Future
visual work executes convention at that finish level rather than proposing
new worlds, unless the user reopens the question.
