# Quarry

[![CI](../../actions/workflows/ci.yml/badge.svg)](../../actions/workflows/ci.yml)

**Live demo:** _one-command deploy is configured — see [Deployment](#deployment). If you're reading this on the hosted repo, the maintainer's live URL is pinned in the repo's About sidebar._

A bug tracker built on an old, mostly forgotten idea: **a bug's death deserves as much structure as its life.** Modern trackers flattened the issue lifecycle into a Kanban status column and lost three things along the way — *why* a bug stopped (resolution), *what it was connected to* (dependencies and duplicates), and *whether it ever came back* (regressions). Quarry keeps all three, then goes one step further: when a new bug arrives, it checks whether it's an old, already-fixed bug returning.

Seeded with a realistic corpus (~320 issues across three products with full histories), so every screen is populated on first run.

## Quick start

Requires **Node 22.5+** (uses the built-in `node:sqlite` — nothing to compile, no external services).

```sh
npm install
npm run dev        # → http://localhost:5000  (API on :5050)
```

The database seeds itself on first run. Other commands:

```sh
npm test           # integration suite over the real HTTP app (36 tests)
npm run build      # type-check + production bundle
npm start          # production mode: one server on :5000 serving app + API
npm run seed       # wipe ./data and reseed from scratch
npm run test:a11y  # axe-core WCAG A/AA audit (build first; needs Playwright Chromium)
```

## Studying the reference: what Bugzilla got right, and what I kept

Bugzilla's model looks baroque next to Linear or GitHub Issues, but most of its "complexity" is encoded operational wisdom from running large projects. Before building, I went through its model piece by piece and made a call on each:

| Bugzilla concept | Verdict | Reasoning |
|---|---|---|
| Product → Component hierarchy | **Kept** | A flat project list can't express "this bug is in the gateway of the messaging backend." Components carry owners and give triage its routing structure. Issue keys are minted per product (`RELAY-162`), human-readable and stable. |
| Status *and* Resolution as separate axes | **Kept** — the core of the design | `RESOLVED` alone is a lie of omission. `RESOLVED FIXED` and `RESOLVED WONTFIX` are opposite outcomes that a one-axis model can't distinguish. Quarry enforces that entering `resolved` *requires* a resolution, and reopening clears it. Analytics can then answer "how do our bugs actually end?" |
| Severity vs Priority as separate fields | **Kept** | Impact and urgency are different facts. A crash in a deprecated feature is `critical` severity, `p4` priority. Collapsing them (the common modern shortcut) makes triage arguments unresolvable because two people are using one field to mean two things. |
| `UNCONFIRMED` as a distinct entry state | **Kept** | The gap between "reported" and "reproduced by the team" is where triage actually happens. Reopened bugs deliberately do *not* return to unconfirmed — reproduction knowledge isn't un-learnable. |
| `VERIFIED` between resolved and closed | **Kept** | "Developer says fixed" and "someone else confirmed it" are different facts; QA sign-off lives in that gap. |
| Duplicate marking with history merge | **Kept** | Duplicates are signal, not noise — each one is independent evidence of impact. Resolving as `duplicate` requires the canonical key and merges watchers into it, so nobody following the duplicate loses the thread. |
| Blocks / depends-on graph | **Kept & promoted** | Almost every modern lightweight tracker dropped dependency graphs; they were among Bugzilla's most operationally useful features. Quarry enforces acyclicity server-side and renders the whole graph as an interactive map. |
| CC list (watchers) | **Kept** | Lightweight interest without assignment. Reporters and commenters auto-subscribe; duplicate and regression links propagate watchers. |
| Per-field permission matrix, groups, flags | **Dropped** | 1998-era enterprise access control. The cost (admin surface, friction) no longer buys much for most teams. Quarry uses a lightweight actor switcher so every action is still attributed. |
| Email-centric workflow | **Dropped** | Replaced by in-app watchers + timeline. Email was the notification transport of its era, not the idea. |
| `MOVED`, `LATER`, `REMIND` resolutions | **Dropped** | Bugzilla itself deprecated them; they encoded queue management into the resolution axis where it doesn't belong. Priority covers it. |

The through-line: I kept everything that encodes *judgment about how bugs actually behave*, and dropped what encoded *the constraints of 1998* (email, enterprise ACLs, server-rendered CGI ergonomics).

## The workflow model

```
                      ┌─────────────┐
   new report ──────▶ │ unconfirmed │──────────────┐
                      └──────┬──────┘              │
                     repro'd │                     │
                      ┌──────▼──────┐              │
              ┌──────▶│  confirmed  │──────────┐   │
              │       └──────┬──────┘          │   │
       reopen │       picked │up               │   │
   (clears    │       ┌──────▼──────┐          │   │ resolve
   resolution)│  ┌───▶│ in_progress │────┐     │   │ (requires a
              │  │    └──────┬──────┘    │     │   │  resolution:
              │  │ rework    │ PR up     │     │   │  fixed / wontfix /
              │  │    ┌──────▼──────┐    │     │   │  duplicate / invalid /
              │  └────│  in_review  │    │     │   │  worksforme)
              │       └──────┬──────┘    │     │   │
              │              │           ▼     ▼   ▼
              │       ┌──────┴──────────────────────┐
              ├───────│           resolved          │
              │       └──────┬───────────────────── ┘
              │     QA-confirmed
              │       ┌──────▼──────┐        ┌────────┐
              ├───────│  verified   │───────▶│ closed │
              │       └─────────────┘        └────┬───┘
              └───────────────────────────────────┘
```

Every transition is validated **server-side** in one place (`server/domain/workflow.ts`). An illegal move returns `409` with a machine-readable error naming the legal next states — try it directly:

```sh
curl -s -X POST localhost:5050/api/issues/RELAY-1/transition \
  -H 'content-type: application/json' -d '{"to":"closed","actorId":1}'
# → {"error":"illegal_transition","message":"Cannot move from … Legal next
#    states: …","legalNextStates":[…],"currentStatus":"…"}
```

Guard rules beyond the graph: entering `resolved` requires a resolution; `duplicate` additionally requires the canonical issue's key (and triggers the watcher merge); entering `in_progress` requires an assignee; reopening clears resolution and `resolved_at` and is recorded as its own event kind. The board UI mirrors these rules (illegal columns dim and explain themselves), but the UI is never the enforcement layer.

## Data model

```
products ─┬─▶ components ─┐
          │                ├─▶ issues ─┬─▶ issue_labels
          └── next_seq     │           ├─▶ watchers (actor ↔ issue)
              (key minting)│           ├─▶ comments
                           │           ├─▶ events        (full audit trail)
   actors ─────────────────┘           └─▶ relations     (blocks /
                                            duplicate_of / regression_of)
   issue_fts (SQLite FTS5) ◀── kept in sync on every write
```

Every mutation writes an `events` row (actor, kind, field, from → to, timestamp). The history rail on an issue page is a straight render of that table — nothing is reconstructed after the fact.

## Architecture and stack

**Hono (Node) API server + Vite/React SPA, TypeScript end to end, SQLite via `node:sqlite` with FTS5.**

The alternative I seriously considered and rejected was **Next.js (App Router) with server actions** — it's the default reflex for this kind of app and it would have worked. I rejected it for one architectural reason: this brief's center of gravity is *server-enforced business rules that must be independently checkable*. A meta-framework blurs exactly that boundary — logic migrates into server components and actions, and "hit the API directly to prove the rules hold" stops being a first-class story. With a standalone Hono app, the entire rule surface is a plain HTTP API: the test suite exercises it without a browser, a judge can poke it with `curl`, and the React app is demonstrably just one client among possible many. The runtime is also drastically lighter (the API server is ~6 dependencies), and SQLite via the Node built-in means `npm install` compiles nothing and phones no one.

Persistence is a single-file SQLite database in `./data/` (WAL mode). The storage layer is plain SQL behind one module boundary (`server/store.ts` + `server/db.ts`); swapping to Postgres would be a driver + dialect change, not a redesign. Full-text search is a real FTS5 index over key/title/body/labels, updated in the same transaction as every write — search on 300+ issues is instant and doesn't degrade with a `LIKE` scan.

## Lineage — the differentiating feature

**The one-sentence pain:** when an already-fixed bug regresses, it re-enters triage as a brand-new report, and the person assigned starts from zero while the root-cause analysis, the fix, and the people who understood it sit forgotten in a closed ticket.

**Why mainstream trackers haven't built it:** it requires treating the tracker's own resolution history as a queryable corpus and — harder — being honest about uncertainty. A feature that says "this *might* be a regression of X, and here is exactly why I think so" is genuinely useful; one that's confidently wrong is worse than nothing. Vendors optimizing for demo-confidence ship the latter or nothing.

**Is it real?** Yes — no external services, no pretrained anything, and inspectable end to end (`server/domain/lineage.ts`). For an open issue, Quarry compares it against every `fixed` bug in the same product using **four independent signals**:

1. **Lexical** — TF-IDF cosine similarity over title + body, IDF computed over the live corpus (shared *rare* words count; shared boilerplate doesn't).
2. **Structural** — same component, plus label overlap: where in the product it bit.
3. **Trace** — file paths, stack frames, and error class names are parsed out of both reports and compared; two reports that share `gateway/tls_resume.ts` and `SessionCache.restore` are related in a way prose similarity can't fake.
4. **Timing** — regressions cluster in the weeks after a fix ships; the signal decays exponentially with the gap between the ancestor's resolution and the new report.

The four scores are **shown separately, with their evidence** ("shared frames: gateway/tls_resume.ts", "fix shipped 22 days before this report"), plus an agreement measure: *how many of the four signals independently vote yes*. A candidate only gets the `strong` verdict with high combined score **and** 3-of-4 consensus — one loud signal against three silent ones is displayed as exactly that, not blended into a falsely-confident single number.

**The live moment:** open the seeded issue *"Intermittent websocket disconnects after deploy"* (`RELAY-162` in the default seed) and press **Scan ancestry**. The signal bars sweep in, and the verified fix from three weeks earlier surfaces as a strong match — trace evidence named explicitly. One click confirms the lineage: the relationship is recorded, the ancestor's watchers are subscribed to the new issue (the people who cared about the fix hear that it broke), both audit trails note it, and the issue header now renders the full ancestry chain. Confirmed lineage feeds the dependency graph and the analytics regression counter.

Duplicate detection asks *"has someone already reported this?"* Lineage asks a different question — *"did we already fix this, and is it back?"* — which is precisely the question the status/resolution split exists to make answerable.

## The screens

- **Triage** — filterable, sortable list over the full corpus; FTS5 search across title/body/key/labels; URL-driven filters so views are shareable.
- **Board** — drag between workflow columns. While dragging, illegal target columns dim with the reason inline; drops still go to the server, which re-validates.
- **Issue** — markdown description, discussion, complete audit rail, relationship editor, watcher management, legal-next-state buttons, and the Lineage panel.
- **Graph** — force-directed map of every blocks / regression / duplicate edge; hover isolates a node's neighborhood.
- **Analytics** — opened-vs-resolved trend (26 weeks), status/severity/resolution distributions, per-assignee load, mean time to resolution, oldest open issue, reopen and regression counts. All computed from the rows.
- **⌘K palette** — navigation, actions, and live issue search. Keyboard: `c` files an issue, `g` `t/b/g/a/p` jumps between views.
- **Actor switcher** — every action is attributed; identity is a header control, not an auth ceremony.

Design: warm graphite surfaces with a single ember accent; Spline Sans / Spline Sans Mono / Fraunces; an ambient cursor-reactive canvas field that stays out of the data's way. Focus states are visible everywhere, interactive elements are labeled, contrast stays WCAG-conscious, `prefers-reduced-motion` collapses animation to a static frame, and empty/loading/error states are designed rather than defaulted.

## Live collaboration

Quarry is multiplayer in real time, not just structurally. Every server mutation is published on an in-process change bus and streamed to clients over **SSE** (`GET /api/stream`) — chosen over WebSockets because all events flow server → client, browsers reconnect to SSE automatically, and it adds zero dependencies or proxy-hostile protocol upgrades. An open issue page:

- shows a presence chip when someone else has the same issue open (heartbeat with a 40s server-side TTL, `PUT /api/issues/:key/presence`),
- refetches and flashes *"updated just now by ⟨name⟩"* when another actor transitions, edits, comments on, relates, or watches it — no refresh.

Try it: open the same issue in two tabs, pick different identities from the actor switcher, and change status in one.

## Security

What's implemented, all server-side (`server/security.ts`), verified by tests:

- **Security headers** on every response: a strict Content-Security-Policy (`default-src 'self'`; the only allowances are Google Fonts and inline styles for React style props; `frame-ancestors 'none'`, no remote scripts), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, COOP, and a minimal Permissions-Policy.
- **Explicit CORS allowlist** — never `*`. Defaults to the local dev origins; override in production with `ALLOWED_ORIGINS=https://your.host` (comma-separated).
- **Rate limiting** on all mutating routes (POST/PATCH/PUT/DELETE): an in-memory sliding window, 120 writes/minute per client, returning `429` with `Retry-After`. Reads are unlimited.
- **Payload caps and input validation** with explicit `4xx` errors, never silent truncation: 64 KB request-body ceiling (`413`), titles ≤ 200 chars, descriptions ≤ 20,000, comments ≤ 10,000, ≤ 12 labels with a strict charset.
- **No injection surface**: every SQL statement is parameterized; FTS query terms are quoted; markdown renders through React elements only — no `innerHTML` anywhere, so stored XSS has nowhere to land, with CSP as the second layer.
- **Repo hygiene**: the SQLite files (`data/`, `*.db*`) and env files are gitignored; the app needs no secrets to run.

Honest scope note: there is no authentication layer — identity is a deliberate lightweight actor switcher (per the product's design), so rate limits key on client address, not user.

## Accessibility

- **Tested automatically**: `npm run test:a11y` boots the production build and runs axe-core (WCAG 2.0/2.1 A + AA rulesets) against Triage, Board, an issue page with the Lineage panel open, Analytics, and Products — the run fails on any violation, and CI runs it on every push. Currently: zero violations on all five screens.
- **Manually verified, keyboard only**: ⌘K palette → search → open an issue → transition its status → comment → navigate away, with no mouse. Focus is always visible (2px accent ring), interactive elements carry labels, dialogs are `aria-modal`, live regions announce collaboration updates, and a skip-to-content link is first in the tab order.
- **Contrast**: all text tokens — including the faintest secondary text, status pills, and severity glyphs — were adjusted to ≥ 4.5:1 against the lightest surface they appear on (verified by axe, not eyeballed).
- **Known limitations**: drag-and-drop on the Board has no keyboard equivalent — the same action is fully available via the issue page's transition buttons (which is also where the server explains legal moves); the dependency graph is mouse-first, with the same relationships listed accessibly on each issue page.

## Deployment

Configured for **Render** (`render.yaml`, free tier) because the app is a classic long-lived Node server — SSE streams and an on-disk SQLite file want a persistent process, not serverless functions. Two paths:

- **Render (one click)**: *New → Blueprint*, point it at this repo. The blueprint sets Node 22, `npm ci && npm run build`, `npm start`, and a health check on `/api/meta`.
- **Any Docker host (Railway/Fly/self-hosted)**: `docker build -t quarry . && docker run -p 5000:5000 quarry`.

The live database sits on the instance's disk: on the free tier it's ephemeral, so **the demo corpus reseeds automatically on each deploy or restart** (seeding is a single transaction, ~1–2s). For a demo that's a feature — the app can never arrive empty or half-migrated; for production you'd mount a persistent disk (one line in `render.yaml`) or point the store at a hosted database. Set `ALLOWED_ORIGINS` if the API will be called cross-origin; same-origin use needs no configuration.

## Tests

`npm test` runs 36 integration tests through the real HTTP app (routing, JSON parsing, error mapping) against real SQLite databases — a seeded corpus plus a fresh one for lifecycle walks. Covered: seeding shape, vocabulary/meta, filters and FTS sync, full legal lifecycle with audit verification, illegal-transition rejection (with `legalNextStates` asserted), resolution requirements, reopening semantics, duplicate merge with watcher union and chain rejection, dependency cycle rejection, regression confirmation with watcher inheritance and ancestry chain, comment validation and auto-subscription, per-field audit events, lineage ranking (the true ancestor must win with a decisive trace signal) and lineage honesty (strong verdicts require consensus; empty history finds nothing), analytics aggregates, graph consistency, and structured 404/400 errors. The hardening batch added: security-header and CSP assertions, CORS allowlist behavior (reflects allowed origins, never wildcards), rate-limit 429s with `Retry-After` (writes limited, reads open), 413 payload rejection, oversized description/comment/label rejection, presence join/leave semantics, and an SSE assertion that a mutation by one actor is delivered as an `issue_changed` event naming the issue and the actor. Accessibility has its own runner: `npm run test:a11y` (see above).

## Five-minute walkthrough

1. Open the live URL (or `npm install && npm run dev` → `http://localhost:5000`). Triage is populated with ~320 issues immediately.
2. Type a word in the search box (try `handshake`), flip a severity filter, sort by severity. Open any issue.
3. On the issue: change severity, assign someone, comment — then open the **History** tab: every one of those actions is in the audit rail with actor and timestamp.
4. **Board**: drag a card from `unconfirmed` toward `closed` — the column dims and explains itself; drop it anyway and the server's 409 with legal next states surfaces as the error. Drag to `confirmed`, then to `resolved` — a resolution is demanded.
5. Prove enforcement is server-side with the `curl` from the workflow section above.
6. **The beat**: press ⌘K, type `intermittent websocket`, open the unconfirmed report, press **Scan ancestry**. Watch the fixed ancestor light up with per-signal evidence, click **Confirm regression of …**, and see the ancestry chain render and the watchers arrive. Check **Analytics** — the regression counter ticked.
7. **Graph**: hover the node you just linked — its lineage edge is the violet one.
8. **Live collaboration**: open the same issue in two tabs (pick different people in the actor switcher, top right). Change status in one tab — the other updates in place with *"updated just now by ⟨name⟩"*, and each tab shows who else is viewing.
9. `npm test` — 36 passing. `npm run test:a11y` — zero WCAG A/AA violations.

## What changed since the first cut

- **Security**: strict CSP + security headers, explicit CORS allowlist, per-client write rate limiting, request-size caps, and hard input limits with structured errors — all covered by new tests.
- **Live collaboration**: SSE change stream + per-issue presence; open issues update live across sessions with attribution.
- **Verified accessibility**: axe-core (WCAG A/AA) audit wired into the test suite and CI across five screens; contrast tokens corrected to measured ≥ 4.5:1; keyboard-only path manually verified.
- **CI**: GitHub Actions runs the build, the integration suite, and the accessibility audit on every push (badge above).
- **Deployability**: Render blueprint + Dockerfile; seeding now runs as one transaction (~1–2s with progress logs) so first boot never looks like a hang.

## License

MIT — see [LICENSE](LICENSE).
