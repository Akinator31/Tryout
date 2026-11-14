# 0018 — UI kit: Chakra UI for the admin, a framework-free embed, one set of tokens

**Status:** accepted. Milestone M3, design step 4 (see [Roadmap](../roadmap.md)).

## Context

- The M3 Figma file is settled: a visitor embed with twelve states and the admin screens of M4.
  Its variables, text styles and components follow Chakra UI v3 names (`Chakra / primitives`,
  `Chakra / semantic`, `Button`, `Field`, `NumberInput`, `Tabs.Trigger`…), and its cover maps
  each Figma collection to a Chakra theme token.
- The two surfaces have different jobs:
  - the **embed** loads for every portfolio visitor, inside someone else's page, often on a
    phone. It shows one card or one session frame with a thin bar; its weight is paid on every
    visit, before the visitor sees anything;
  - the **admin** is used by the operator: forms checked against the schema, tables, a side
    panel, a review dialog, keyboard use. It is loaded rarely, by one person.
- [ADR 0008](0008-stack-and-license.md) names Chakra UI as the candidate kit and asks for a
  minimal embed page.
- The identity is a token system: neutral blacks, paper text, one amber accent that means
  "you", IBM Plex Sans, Sans Condensed and Mono, 3 px and 8 px radii. The embedding site may
  override the accent, the logo and the texts.
- The control plane runs TypeScript directly with Node's type stripping and has no build step.
  Browsers cannot run TypeScript or JSX, so any UI needs one.
- The project must not depend on outside services: no font or script CDN at runtime.

## Decision

- **Admin: React with Chakra UI v3.** The Figma components map to Chakra components and slot
  recipes one to one (`StatusCard`, `SessionBar` and `ProjectRow` become recipes in the theme).
  Chakra, through Ark UI, brings accessible dialogs, menus, fields and focus handling that the
  admin needs and that are costly to write well.
- **Embed: TypeScript without a UI framework.** A small state machine renders the card, the
  session frame and the bar from the ticket stream, as the current page does, with plain DOM and
  CSS. No React, no CSS-in-JS runtime. Budget: under 15 kB of JavaScript and 10 kB of CSS,
  compressed, fonts excluded; CI fails above it.
- **One set of tokens.** A single TypeScript module holds the design tokens as they are in Figma
  (colours, type styles, spacing, radii). It feeds Chakra's `createSystem` for the admin and is
  emitted as CSS custom properties for the embed. The embedding site's accent override replaces
  the accent properties only.
- **Fonts are bundled.** IBM Plex (SIL Open Font License) is served by the control plane:
  Latin subsets, `font-display: swap`. Each surface loads only the weights it uses: the embed
  needs a few (Sans for text, Sans Condensed for the queue number, Mono for the countdown).
- **One UI package, built once.** A new `apps/ui` package, built with Vite, produces two entry
  points (`embed` and `admin`) as static files. The control plane image copies the build output
  and serves it; the control plane itself keeps running TypeScript without a build. The page
  shells stay server-rendered, so the embed's headers (`frame-ancestors`, `no-referrer`) do not
  change.

## Consequences

- The embed stays light enough for a first paint inside a portfolio, and the admin gets a
  complete component kit. Both look the same because they read the same tokens.
- Figma and code share names: a change in Figma maps to one token or one recipe. Keeping the
  token module in step with Figma is manual; a test checks that the CSS properties and the
  Chakra system come from the same module.
- The embed's states are hand-written. Each one needs its own test (rendering for every ticket
  state, keyboard focus, `aria-live` announcements), since no kit provides them.
- The repository gains a frontend build: Node packages for Vite, React and Chakra, a build stage
  in the control plane's Dockerfile, and a CI job. Dependabot covers the new packages.
- Chakra's runtime (Emotion) is accepted for the admin only. If its size or its React
  compatibility becomes a problem, the tokens and the Figma names stay; only the admin's
  components change.

## Alternatives considered

- **Chakra for both surfaces**: one kit to learn, but React, React DOM and Emotion would load
  for every visitor to render one card, several times the embed budget.
- **Tailwind with copied components (shadcn/ui)**: no runtime and full control, but its default
  look is the template the M3 design moved away from, and the admin's accessible widgets would be
  ours to maintain.
- **Ark UI or Park UI directly**: the same accessible primitives as Chakra with less runtime,
  but every visual component would be written by hand; Chakra already maps to the Figma file.
- **Preact for the embed**: JSX and components for about 4 kB, but the embed is one state
  machine and a few elements; a framework adds a dependency without removing code.
- **Fonts from a CDN**: smaller images, but every visitor's browser would contact a third party,
  and the project would depend on it.
