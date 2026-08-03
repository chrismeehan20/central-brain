# 0003 — centralbrain.secondbell.app landing page

Status: **in progress**
Date opened: 2026-08-03
Driver: `/loop-queue` (one gated build-loop at a time, merged green before the next starts)

---

## Why this exists

Central Brain is public and MIT-licensed but has no page a person can be sent
to. The README is the only front door, and a README is a bad pitch: it opens
with architecture, buries the install command a third of the way down, and
assumes the reader already knows what the app is for.

The mandate: a landing page at `centralbrain.secondbell.app` that describes
the features, gives install instructions, labels the app clearly as beta, and
links to the GitHub repo.

## Where it lives, and why

`secondbell.app` is registered in the `chrismeehan20s-projects` Vercel account
with Vercel nameservers. A prior decision (recorded in the Second Bell website
repo's memory) reserves that domain **for individual tools**, keeping
`thesecondbell.com` as the brand's canonical domain. Central Brain is exactly
the kind of tool that reservation was for.

`centralbrain.secondbell.app` resolves today (wildcard on the zone) but returns
`DEPLOYMENT_NOT_FOUND` — no project claims it yet.

The page lives in **this repo**, at `site/`, deployed as its own Vercel project
with root directory `site/`. Three reasons:

1. It matches the house pattern already established in
   `secondbell-school-apps`: `apps/web/site/` and `apps/perch-extension/site/`
   are both single-file static marketing pages with their own `vercel.json`
   carrying a strict CSP.
2. Install instructions that live beside the code they document cannot drift
   from it. A Homebrew cask name or a Node floor changes in one commit, not two
   repos.
3. `secondbell-school-apps` was considered and rejected. Its `CLAUDE.md` scopes
   that monorepo to four school-software products; it is private, and Central
   Brain is a public developer tool. A standalone repo was also rejected: it
   splits the install docs from the app for the sake of one static page.

## Ratified product decisions (2026-08-03)

| Question | Decision |
|---|---|
| Where the site lives | `site/` in this repo, own Vercel project, root dir `site/` |
| Product screenshot | Real capture of the running dashboard, with visible project cards renamed to neutral demo names first and restored afterward — the genuine UI without publishing a private project list |
| Relationship to Second Bell | Central Brain gets its own identity. A quiet "from Second Bell" line in the footer linking to `thesecondbell.com`. The school-software brand stays unmuddied by a developer tool |
| Email capture / CTA | None. Download and GitHub only. Keeps the page static and the CSP tight, and matches the app's own no-SaaS posture |

## The queue

| # | Loop | Scope | Tier | Status |
|---|---|---|---|---|
| 1 | Landing page | Copy (humanizer pass, then my-voice pass), design plan per `my-design`, `site/index.html`, `site/vercel.json`, screenshot asset, this record | ordinary | in progress |
| 2 | Go live | Vercel project + `centralbrain.secondbell.app` domain attachment, production deploy, verification, README link to the site | ordinary | queued |
| 3 | README voice pass | Run `my-voice` over `README.md`. Added to the queue by Chris mid-Loop-1 (2026-08-03) | simple | queued |

Loop 3 is deliberately a **surgical** pass, not a rewrite. The README is
reference documentation, where plain and neutral already is the correct human
voice; the `humanizer` rulebook says so explicitly. So Loop 3 fixes the
mechanical tells (the README currently carries roughly two dozen em dashes),
ban-list vocabulary, header case, and sentence rhythm. It does not restructure
sections, collapse the genuinely list-shaped feature list into prose, or change
a single technical claim. Facts are verified against the code, not reworded on
vibes.

Loop 1 is implemented by the orchestrator directly rather than delegated to a
maker agent. The `humanizer`, `my-voice`, and `my-design` rulebooks are
personal standards loaded into the orchestrator's context; handing copy and
type choices to a down-tier agent is precisely where those standards get lost.
The independent-verification step still applies: the gate is re-run on the
working tree before anything is committed.

## Gate

This repo's CI (`.github/workflows/ci.yml`) is `npm ci` → `npm run typecheck` →
`npm test` → `npm run build`. The `site/` folder is static HTML outside every
`tsconfig` include path and outside the Vite root, so it is not compiled by the
gate — but the gate still has to pass unchanged, proving the addition is inert
with respect to the app.

Baseline before Loop 1, recorded per build-loop rule 1: `npm test` passes at
**250 tests, 0 failures**; typecheck and build both exit 0.

## Constraints carried into the build

- **Beta, stated plainly.** The app is unnotarized, macOS-only, and
  Apple-Silicon-only. The page says so above the fold, not in fine print.
- **`my-design` ban list binds.** No Inter, no Space Grotesk or Manrope as
  headings, no Playfair, no reflexive JetBrains Mono, no left-border card
  accents, no aurora blobs, no all-caps kickers, no gradient headings.
  Note that the existing Second Bell static sites (`apps/web/site`,
  `apps/perch-extension/site`) predate this rulebook and use Inter or
  Montserrat. They are not the type reference; only their file structure and
  CSP posture are.
- **`my-voice` ban list binds.** No em dashes anywhere in the copy, no rule of
  three, no inflated significance verbs, sentence-case headers.
- **Quality floor.** Responsive, visible keyboard focus, `prefers-reduced-motion`
  respected, real content.
