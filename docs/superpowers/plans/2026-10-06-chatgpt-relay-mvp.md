# ChatGPT Relay MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Chrome 145+ Manifest V3 extension that safely relays completed ChatGPT responses between exactly two ChatGPT tabs in one native Split View, with persisted causal identity, conversation binding, fail-closed recovery, and explicit Stop/max-turn controls.

**Architecture:** A static content script owns all ChatGPT DOM knowledge through `ChatGPTAdapter`; a Manifest V3 service worker is the single authoritative `RelaySession` writer and serializes all state transitions through persisted revision/revalidation; a popup is a thin control/status surface. Relay correctness is anchored to persisted `sessionId + waitId + causedByUserMessageId`, immutable per-side conversation bindings, `PendingTransfer` persist-before-side-effect, and transcript ancestry validation.

**Tech Stack:** TypeScript, Chrome Extensions Manifest V3 APIs, esbuild, Vitest, happy-dom, Playwright Chromium integration tests, npm.

**Spec:** `docs/superpowers/specs/2026-10-06-chatgpt-relay-mvp-design.md`

## Global Constraints

- Minimum supported Chrome version: **145**.
- Manifest version: **3**.
- Allowed extension permission: **`storage` only**.
- Allowed host permission and static content-script match: **`https://chatgpt.com/*` only**.
- Do **not** add `tabs`, `activeTab`, `scripting`, `<all_urls>`, `webRequest`, or `debugger` without returning to Design Review.
- `chrome.tabs.createSplit()` is outside the MVP; user-created native Split View is required.
- A is the active eligible ChatGPT tab when Start is accepted; B is the other tab with the same non-default `splitViewId`.
- Active session state is authoritative in `chrome.storage.session`; durable user preferences use `chrome.storage.local`.
- The service worker is the single authoritative `RelaySession` writer; all state mutation passes through one serialized transition path.
- Persist `PendingTransfer` before any external submission side effect.
- Never blind-retry an ambiguous submission.
- Automated response acceptance requires persisted `sessionId + waitId + causedByUserMessageId` and proven transcript ancestry; `causedByTransferId` alone is insufficient.
- Per-side `ConversationBinding` becomes immutable once bound; same-origin conversation switches fail closed.
- The only allowed manual transcript submission during an active relay is the initial A prompt; later manual submit/regenerate/edit/branch interference fails closed.
- Relay payload is text only and uses the fixed Design envelope.
- Default `maxTurns` is **10** and one A→B or B→A transfer counts as one turn.
- DOM selectors, debounce duration, fixture representation, and helper decomposition are implementation details, but selector ambiguity must fail closed.
- Production source/tests/manifest/CI/config/release metadata must not be changed until this plan passes its own Review Gate.

## File Structure

Implementation is expected to create the following focused units:

```text
chatgpt-relay/
├── package.json
├── package-lock.json
├── tsconfig.json
├── vitest.config.ts
├── scripts/
│   └── build.mjs
├── public/
│   └── manifest.json
├── src/
│   ├── background/
│   │   ├── service-worker.ts
│   │   ├── relay-controller.ts
│   │   ├── session-store.ts
│   │   ├── transition-queue.ts
│   │   └── split-view.ts
│   ├── content/
│   │   ├── index.ts
│   │   ├── chatgpt-adapter.ts
│   │   ├── dom-contract.ts
│   │   ├── transcript-identity.ts
│   │   └── completion-tracker.ts
│   ├── popup/
│   │   ├── popup.html
│   │   └── popup.ts
│   └── shared/
│       ├── domain.ts
│       ├── protocol.ts
│       └── errors.ts
├── tests/
│   ├── background/
│   ├── content/
│   │   └── fixtures/
│   ├── integration/
│   └── shared/
└── docs/superpowers/
    ├── specs/
    └── plans/
```

Responsibilities are locked as follows:

- `shared/domain.ts`: Design domain types only; no Chrome/DOM access.
- `shared/protocol.ts`: extension message union and runtime structural validation.
- `shared/errors.ts`: machine-readable relay error/stop reasons.
- `background/session-store.ts`: persisted session/preferences access only.
- `background/transition-queue.ts`: in-lifetime serialization primitive only.
- `background/split-view.ts`: pure pair discovery/validation and Split View change evaluation.
- `background/relay-controller.ts`: authoritative state-machine orchestration; no DOM selectors.
- `background/service-worker.ts`: Chrome event/message wiring into the controller only.
- `content/dom-contract.ts`: current ChatGPT DOM selectors/semantic probes and fail-closed DOM inspection.
- `content/transcript-identity.ts`: conversation/message identity derivation and transcript ancestry helpers.
- `content/completion-tracker.ts`: wait-scoped buffering/completion/interference state.
- `content/chatgpt-adapter.ts`: adapter lifecycle and UI submission orchestration using the content helpers.
- `content/index.ts`: runtime message wiring into one adapter instance.
- `popup/*`: Start/Stop/maxTurns/status UI only.

## Review Focus

The following failure modes must have explicit tests in their owning tasks:

1. **ChatGPT DOM drift/ambiguity:** selector/probe matches zero or multiple plausible composer/transcript targets → adapter reports an actionable fail-closed error; it never guesses.
2. **Conversation changes between prepare and commit:** same tab/origin/Split View but different bound conversation → commit is prohibited and session enters `conversation-changed`.
3. **Manual transcript interference during an automated wait:** user submit/regenerate/edit/branch evidence appears after the relay-owned user turn → expected completion is rejected and relay fails closed.
4. **Service-worker suspension or async continuation after newer state:** stale revision/session/wait/transfer continuation returns → it must not overwrite newer `stopping`, `stopped`, or `error`.
5. **Popup closes/reopens during an active relay:** no relay state is owned by the popup; reopening reconstructs status from the controller/session store without starting, stopping, or mutating the relay.

---

### Task 1: Build, Test, and Manifest Scaffold

**Files:**
- Create: `package.json`
- Create: `package-lock.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `scripts/build.mjs`
- Create: `public/manifest.json`
- Create: `src/background/service-worker.ts`
- Create: `src/content/index.ts`
- Create: `src/popup/popup.html`
- Create: `src/popup/popup.ts`
- Create: `tests/integration/manifest-contract.test.ts`

**Responsibilities:**
- Establish a framework-free TypeScript MV3 build.
- Bundle service worker, content script, and popup script as separate esbuild entry points.
- Copy `public/manifest.json` and popup HTML into `dist/`.
- Lock the Design-approved Chrome/permission boundary before feature code exists.

**Interfaces:**
- Consumes: none.
- Produces:
  - npm scripts `build`, `test`, `test:unit`, `test:integration`.
  - `dist/manifest.json`, `dist/background.js`, `dist/content.js`, `dist/popup.js`, `dist/popup.html`.
  - Manifest contract: `minimum_chrome_version === "145"`, `permissions === ["storage"]`, host/content match exactly `https://chatgpt.com/*`.

- [ ] **Step 1: Write the failing manifest contract test**

In `tests/integration/manifest-contract.test.ts`, add tests named:

```ts
it("pins Chrome 145 and the approved permission boundary", ...)
it("does not request forbidden MVP permissions", ...)
it("injects the static content script only on chatgpt.com", ...)
```

Assertions must require exactly the Global Constraints values.

- [ ] **Step 2: Run the test and verify RED**

Run: `npm test -- tests/integration/manifest-contract.test.ts`

Expected: FAIL because `public/manifest.json` and/or test tooling does not exist yet.

- [ ] **Step 3: Add minimal npm/TypeScript/esbuild/Vitest scaffold**

Use dev dependencies:
- `typescript`
- `esbuild`
- `vitest`
- `happy-dom`
- `@playwright/test`
- `@types/chrome`

Do not add a runtime framework.

- [ ] **Step 4: Create the exact MVP manifest contract**

`public/manifest.json` must include:
- `manifest_version: 3`
- `minimum_chrome_version: "145"`
- `permissions: ["storage"]`
- `host_permissions: ["https://chatgpt.com/*"]`
- static `content_scripts.matches: ["https://chatgpt.com/*"]`
- service-worker, action/popup, and built asset paths only.

Do not add forbidden permissions.

- [ ] **Step 5: Add placeholder entry modules and build script**

The entry modules may contain only bootstrapping placeholders needed for bundling; no relay behavior yet.

- [ ] **Step 6: Run build and manifest test for GREEN**

Run:
```bash
npm run build
npm test -- tests/integration/manifest-contract.test.ts
```

Expected: build succeeds and all manifest contract tests PASS.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts scripts/build.mjs public/manifest.json src/background/service-worker.ts src/content/index.ts src/popup/popup.html src/popup/popup.ts tests/integration/manifest-contract.test.ts
git commit -m "build: scaffold Chrome relay extension"
```

---

### Task 2: Shared Domain Types, Errors, and Message Validation

**Files:**
- Create: `src/shared/domain.ts`
- Create: `src/shared/errors.ts`
- Create: `src/shared/protocol.ts`
- Create: `tests/shared/protocol.test.ts`

**Responsibilities:**
- Encode the Design vocabulary once.
- Keep runtime messages structurally validated at trust boundaries.
- Prevent controller/adapter tasks from inventing incompatible type names.

**Interfaces:**
- Consumes: Task 1 TypeScript/test scaffold.
- Produces:
  - `Side = "a" | "b"`
  - `ConversationBinding`
  - `TranscriptMessageIdentity`
  - `AssistantResponse`
  - `ExpectedResponse`
  - `PendingTransfer`
  - `RelayState`
  - `RelaySession`
  - `RelayMessage`
  - `RelayFailureReason`
  - `parseRelayMessage(value: unknown): RelayMessage | null`

- [ ] **Step 1: Write failing protocol/type-boundary tests**

Add tests named:

```ts
it("accepts assistant-complete only with sessionId waitId and message", ...)
it("accepts transfer-committed with userMessageId and conversationIdentity", ...)
it("rejects malformed or unknown message shapes", ...)
it("enumerates conversation-changed relay-causality-ambiguous and message-identity-ambiguous", ...)
```

Include compile-time use of the exact Design fields:
- `conversationA`, `conversationB`
- `revision`
- `expectedResponse`
- `pendingTransfer`
- `causedByUserMessageId`
- `targetUserMessageId`.

- [ ] **Step 2: Run RED**

Run: `npm test -- tests/shared/protocol.test.ts`

Expected: FAIL because shared modules do not exist.

- [ ] **Step 3: Implement the shared types**

Keep these files free of Chrome and DOM imports.

- [ ] **Step 4: Implement `parseRelayMessage(value: unknown): RelayMessage | null`**

Use explicit type guards; do not add a schema-validation runtime dependency.

- [ ] **Step 5: Run GREEN**

Run: `npm test -- tests/shared/protocol.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/shared tests/shared
git commit -m "feat: define relay protocol contracts"
```

---

### Task 3: Persisted Session Store and Serialized Transition Boundary

**Files:**
- Create: `src/background/session-store.ts`
- Create: `src/background/transition-queue.ts`
- Create: `tests/background/session-store.test.ts`
- Create: `tests/background/transition-queue.test.ts`

**Responsibilities:**
- Make `chrome.storage.session` the authoritative active-session store.
- Make `chrome.storage.local` the durable preferences store.
- Serialize in-lifetime state mutation without pretending Chrome storage is CAS.
- Support revision/session revalidation after awaits.

**Interfaces:**
- Consumes: Task 2 `RelaySession`.
- Produces:
  - `interface RelaySessionStore { read(): Promise<RelaySession | null>; write(session: RelaySession): Promise<void>; clear(): Promise<void>; }`
  - `interface RelayPreferencesStore { readMaxTurns(): Promise<number>; writeMaxTurns(value: number): Promise<void>; }`
  - `createChromeSessionStore(): RelaySessionStore`
  - `createChromePreferencesStore(): RelayPreferencesStore`
  - `class TransitionQueue { run<T>(operation: () => Promise<T>): Promise<T>; }`
  - `assertCurrentSession(current: RelaySession | null, expected: { sessionId: string; revision?: number; waitId?: string; transferId?: string }): RelaySession`

- [ ] **Step 1: Write RED tests for persistence and ordering**

Tests must prove:
- default `maxTurns === 10`;
- session round-trip preserves `revision`, conversation bindings, `ExpectedResponse`, and `PendingTransfer`;
- two queued async operations execute in enqueue order;
- stale revision/session/wait/transfer validation throws/rejects before write.

- [ ] **Step 2: Run RED**

Run: `npm test -- tests/background/session-store.test.ts tests/background/transition-queue.test.ts`

Expected: FAIL because modules do not exist.

- [ ] **Step 3: Implement stores and queue**

Do not cache RelaySession as authoritative module-global state.

- [ ] **Step 4: Implement `assertCurrentSession(...)`**

It validates persisted causal identifiers; it does not mutate.

- [ ] **Step 5: Run GREEN**

Run: `npm test -- tests/background/session-store.test.ts tests/background/transition-queue.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/background/session-store.ts src/background/transition-queue.ts tests/background/session-store.test.ts tests/background/transition-queue.test.ts
git commit -m "feat: add persisted relay session boundary"
```

---

### Task 4: Split View Pair Discovery and Invalidation

**Files:**
- Create: `src/background/split-view.ts`
- Create: `tests/background/split-view.test.ts`

**Responsibilities:**
- Determine A/B without DOM access.
- Enforce same window, exact two eligible ChatGPT tabs, active A, same non-default `splitViewId`.
- Evaluate `tabs.onUpdated` Split View changes as fail-closed invalidation evidence.

**Interfaces:**
- Consumes: Task 2 `Side`.
- Produces:
  - `type TabSnapshot = { id: number; windowId: number; active: boolean; url?: string; splitViewId?: number }`
  - `type SplitPair = { splitViewId: number; tabA: number; tabB: number }`
  - `discoverSplitPair(tabs: readonly TabSnapshot[]): SplitPair`
  - `isPairStillValid(pair: SplitPair, tabs: readonly TabSnapshot[]): boolean`
  - `splitViewChangeInvalidatesPair(pair: SplitPair, tabId: number, nextSplitViewId: number | undefined): boolean`

- [ ] **Step 1: Write RED tests**

Cover:
- active eligible tab becomes A;
- exactly one paired B;
- non-chatgpt URL rejected;
- different window rejected;
- `SPLIT_VIEW_ID_NONE`/missing split rejected;
- changed split ID invalidates persisted pair.

- [ ] **Step 2: Run RED**

Run: `npm test -- tests/background/split-view.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement pure pair logic**

No Chrome API calls inside this module.

- [ ] **Step 4: Run GREEN**

Run: `npm test -- tests/background/split-view.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/background/split-view.ts tests/background/split-view.test.ts
git commit -m "feat: validate ChatGPT split-view pairs"
```

---

### Task 5: Transcript and Conversation Identity Primitives

**Files:**
- Create: `src/content/transcript-identity.ts`
- Create: `tests/content/transcript-identity.test.ts`

**Responsibilities:**
- Implement stable-DOM-ID-first identity precedence.
- Implement deterministic role-ordinal fallback.
- Keep content hash separate from message identity.
- Enforce immutable `ConversationBinding` semantics.

**Interfaces:**
- Consumes: Task 2 `ConversationBinding`, `TranscriptMessageIdentity`, `Side`.
- Produces:
  - `normalizeRelayText(text: string): string`
  - `hashNormalizedText(text: string): string`
  - `deriveTranscriptMessageIdentity(input: { stableDomId?: string | null; conversationIdentity: string | null; role: "user" | "assistant"; roleOrdinal: number | null; text: string }): TranscriptMessageIdentity`
  - `reconcileConversationBinding(binding: ConversationBinding, observed: string | null, authority: "inspect" | "first-allowed-prompt"): ConversationBinding`
  - `assertBoundConversation(binding: ConversationBinding, observed: string | null): string`

**Important:** hashing is deterministic duplicate/content evidence, not a security primitive.

- [ ] **Step 1: Write RED tests**

Include:
- assistant `OK` at ordinal 1 and ordinal 2 have different `messageId` but same `textHash`;
- stable DOM ID takes precedence;
- missing stable ID + missing conversation/ordinal fails with `message-identity-ambiguous`;
- `unbound + first-allowed-prompt + X → bound(X)`;
- `unbound + inspect + X` cannot silently adopt unrelated X;
- `bound(X) + X` passes;
- `bound(X) + Y` fails `conversation-changed`;
- `bound(X) + null` fails when proof is required.

- [ ] **Step 2: Run RED**

Run: `npm test -- tests/content/transcript-identity.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement identity/binding primitives**

Do not inspect DOM in this file.

- [ ] **Step 4: Run GREEN**

Run: `npm test -- tests/content/transcript-identity.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/content/transcript-identity.ts tests/content/transcript-identity.test.ts
git commit -m "feat: add transcript and conversation identity"
```

---

### Task 6: ChatGPT DOM Contract and Deterministic Fixtures

**Files:**
- Create: `src/content/dom-contract.ts`
- Create: `tests/content/dom-contract.test.ts`
- Create: `tests/content/fixtures/idle-existing.html`
- Create: `tests/content/fixtures/generating.html`
- Create: `tests/content/fixtures/completed.html`
- Create: `tests/content/fixtures/new-chat.html`
- Create: `tests/content/fixtures/ambiguous-composer.html`
- Create: `tests/content/fixtures/transcript-interference.html`

**Responsibilities:**
- Centralize every ChatGPT selector/semantic DOM probe.
- Convert current DOM observations into a minimal adapter-facing snapshot.
- Fail closed on zero/multiple ambiguous critical targets.
- Establish fixtures before higher-level adapter behavior depends on selectors.

**Interfaces:**
- Consumes: Task 5 normalization/identity helpers.
- Produces:
  - `type DomInspection = { ready: boolean; generating: boolean; conversationIdentity: string | null; composer: HTMLElement; transcript: TranscriptEntry[] }`
  - `type TranscriptEntry = { role: "user" | "assistant"; stableDomId: string | null; roleOrdinal: number; text: string; branchEvidence: string | null }`
  - `inspectChatGptDom(document: Document): DomInspection`
  - `findSubmitControl(document: Document): HTMLElement`
  - `readTranscript(document: Document): TranscriptEntry[]`

- [ ] **Step 1: Capture the minimum current ChatGPT DOM facts needed by the adapter**

Before implementing selectors, inspect the current `chatgpt.com` UI and record only:
- composer identification;
- send/stop-generating controls;
- user/assistant transcript role markers;
- stable per-message ID if present;
- stable conversation identity source if present;
- observable regenerate/edit/branch evidence if present.

Do not depend on React internals or undocumented network requests.

If a stable message/conversation identity is not directly exposed, keep the Design fallback path; do not broaden architecture.

- [ ] **Step 2: Encode sanitized fixtures and RED tests**

Tests:
- unique idle composer/transcript succeeds;
- generating fixture sets `generating: true`;
- ambiguous composer fixture throws a DOM-contract error rather than choosing one;
- transcript role ordering is deterministic;
- non-ChatGPT-like fixture fails closed.

- [ ] **Step 3: Run RED**

Run: `npm test -- tests/content/dom-contract.test.ts`

Expected: FAIL until selectors/probes exist.

- [ ] **Step 4: Implement current DOM probes in `dom-contract.ts`**

All selector strings live here; no other module may add ChatGPT selectors.

- [ ] **Step 5: Run GREEN**

Run: `npm test -- tests/content/dom-contract.test.ts`

Expected: PASS.

- [ ] **Step 6: Perform a focused manual DOM validation against current `chatgpt.com`**

Load the unpacked extension or execute the inspection helper from a temporary dev harness. Confirm the fixture assumptions against:
- an existing conversation;
- a new chat;
- an actively generating response.

If selectors differ, adjust only `dom-contract.ts` and fixtures. If required semantics cannot be observed safely, stop implementation and return to Design Review.

- [ ] **Step 7: Commit**

```bash
git add src/content/dom-contract.ts tests/content/dom-contract.test.ts tests/content/fixtures
git commit -m "feat: define ChatGPT DOM contract"
```

---

### Task 7: Wait-Scoped Completion Tracker and Interference Detection

**Files:**
- Create: `src/content/completion-tracker.ts`
- Create: `tests/content/completion-tracker.test.ts`

**Responsibilities:**
- Arm exactly one `ExpectedResponse`.
- Buffer a completion that occurs before controller causal binding is confirmed.
- Require exact causal user-message ancestry.
- Detect unexpected manual user turns/regenerate/edit/branch evidence.
- Never emit an unrelated or stale completion.

**Interfaces:**
- Consumes: Task 2 `ExpectedResponse`, `AssistantResponse`; Task 5 identity helpers; Task 6 `TranscriptEntry`.
- Produces:
  - `class CompletionTracker`
  - `arm(expected: ExpectedResponse, snapshot: TranscriptEntry[]): void`
  - `bindUserTurn(input: { waitId: string; userMessageId: string; conversationIdentity: string }): void`
  - `observe(snapshot: TranscriptEntry[], generating: boolean): CompletionObservation`
  - `takeBufferedCompletion(waitId: string): AssistantResponse | null`
  - `type CompletionObservation = { kind: "pending" } | { kind: "complete"; response: AssistantResponse } | { kind: "interference"; reason: RelayFailureReason }`

Use a single exported debounce constant, initially `COMPLETION_STABLE_MS = 500`, so the value is testable and can be tuned without changing protocol semantics.

- [ ] **Step 1: Write RED tests**

Cover:
- no arm → no completion;
- pre-baseline assistant ignored;
- automated wait without `causedByUserMessageId` buffers rather than emits;
- exact relay user turn → following assistant accepted;
- correct transfer label but wrong user ancestry rejected;
- unexpected intervening user turn → interference;
- regenerate/edit/branch evidence → interference when ancestry cannot be proven;
- stale wait cannot emit;
- stable text must remain unchanged for `COMPLETION_STABLE_MS`;
- completion before controller binding is recoverable via buffer.

- [ ] **Step 2: Run RED**

Run: `npm test -- tests/content/completion-tracker.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement tracker as a DOM-independent state machine**

It consumes transcript snapshots; MutationObserver wiring comes later.

- [ ] **Step 4: Run GREEN**

Run: `npm test -- tests/content/completion-tracker.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/content/completion-tracker.ts tests/content/completion-tracker.test.ts
git commit -m "feat: track causal ChatGPT completions"
```

---

### Task 8: ChatGPTAdapter Inspection and Submission Lifecycle

**Files:**
- Create: `src/content/chatgpt-adapter.ts`
- Create: `tests/content/chatgpt-adapter.test.ts`

**Responsibilities:**
- Implement the Design adapter interface using Tasks 5–7.
- Separate prepare from irreversible commit.
- Identify the exact user transcript message created by relay submission.
- Revalidate conversation identity during prepare and immediately before commit.
- Support cancel-before-commit vs already-committed/unknown.
- Never overwrite unexpected user text.

**Interfaces:**
- Consumes: Task 2 protocol/domain; Task 5 identity; Task 6 DOM contract; Task 7 tracker.
- Produces:
  - `class ChatGPTAdapter`
  - `inspect(): Promise<AdapterSnapshot>`
  - `armExpectedResponse(expected: ExpectedResponse): Promise<void>`
  - `prepareSubmission(input): Promise<PreparedSubmission>`
  - `commitSubmission(input): Promise<CommittedSubmission>`
  - `bindExpectedUserTurn(input): Promise<void>`
  - `cancelSubmission(input): Promise<"cancelled-before-commit" | "already-committed" | "unknown">`
  - `startObserving(onEvent: (event: AdapterEvent) => void): () => void`

- [ ] **Step 1: Write RED adapter tests**

Use happy-dom fixtures and fake timers.

Cover:
- inspect returns current conversation/generation/latest identities;
- prepare rejects non-empty unexpected composer text;
- prepare rejects target generating;
- prepare rejects changed bound conversation;
- prepare stages text but does not submit;
- commit revalidates conversation before clicking/dispatching submit;
- commit point is the actual UI send activation;
- committed submission returns exact new `userMessageId` and conversation identity;
- inability to identify the created user message yields `relay-causality-ambiguous`;
- cancel before commit removes staged relay text only when still extension-owned;
- cancellation after commit reports already committed;
- ambiguous DOM state reports unknown/error;
- Review Focus #1: zero/multiple critical DOM targets fail closed.

- [ ] **Step 2: Run RED**

Run: `npm test -- tests/content/chatgpt-adapter.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement adapter inspection/prepare/commit/cancel**

Do not move selectors out of `dom-contract.ts`.

- [ ] **Step 4: Wire MutationObserver through `startObserving` into `CompletionTracker`**

The observer is only a change signal; completion rules remain in Task 7.

- [ ] **Step 5: Run GREEN**

Run: `npm test -- tests/content/chatgpt-adapter.test.ts tests/content/completion-tracker.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/content/chatgpt-adapter.ts tests/content/chatgpt-adapter.test.ts
git commit -m "feat: implement ChatGPT adapter lifecycle"
```

---

### Task 9: Relay Controller Start and Initial A Causal Binding

**Files:**
- Create: `src/background/relay-controller.ts`
- Create: `tests/background/relay-controller-start.test.ts`

**Responsibilities:**
- Start from a discovered pair.
- Inspect both adapters, establish A/B conversation bindings, reject generating A.
- Persist initial A `ExpectedResponse` before reporting Start success.
- Accept exactly one manual initial A user turn, persist `causedByUserMessageId`, then accept only its causally following assistant.

**Interfaces:**
- Consumes: Tasks 2–5 stores, queue, pair discovery, domain types.
- Produces:
  - `interface RelayTransport { inspect(tabId: number): Promise<AdapterSnapshot>; armResponse(tabId: number, expected: ExpectedResponse, authorizationRevision: number): Promise<void>; bindExpectedUserTurn(...): Promise<void>; ... }`
  - `class RelayController`
  - `start(): Promise<RelaySession>`
  - `handleInitialUserTurnObserved(event): Promise<void>`
  - `handleAssistantComplete(event): Promise<void>`
  - controller-owned helper `withTransition(...)` that always uses Task 3 queue/store.

- [ ] **Step 1: Write RED start tests**

Cover:
- active split tab becomes A;
- stable conversation identities bind at Start;
- genuine new chat remains unbound;
- A generating rejects Start;
- pre-Start assistant cannot complete initial wait;
- Start persists wait before transport arm acknowledgement is considered successful;
- exact initial A user turn is persisted in `causedByUserMessageId`;
- assistant completion received before user-turn persistence is buffered/ignored until binding is confirmed;
- second manual A user turn fails closed.

- [ ] **Step 2: Run RED**

Run: `npm test -- tests/background/relay-controller-start.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement Start flow and initial-user-turn event handling**

Preserve the Design ordering exactly.

- [ ] **Step 4: Run GREEN**

Run: `npm test -- tests/background/relay-controller-start.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/background/relay-controller.ts tests/background/relay-controller-start.test.ts
git commit -m "feat: start causal relay sessions"
```

---

### Task 10: Automated Transfer, Conversation Revalidation, and maxTurns

**Files:**
- Modify: `src/background/relay-controller.ts`
- Create: `tests/background/relay-controller-transfer.test.ts`

**Responsibilities:**
- Convert an accepted source assistant into one persisted `PendingTransfer`.
- Revalidate target conversation before prepare and before commit.
- Persist target wait before commit.
- Bind committed `userMessageId` before target assistant can advance the relay.
- Increment turn only after confirmed commit.
- Enforce `maxTurns` before creating the next `PendingTransfer`.

**Interfaces:**
- Consumes: Task 9 controller; Task 8 adapter transport operations.
- Produces controller methods:
  - `handleAssistantComplete(event): Promise<void>` full alternating behavior.
  - `handleTransferPrepared(event): Promise<void>`
  - `handleTransferCommitted(event): Promise<void>`

- [ ] **Step 1: Write RED transfer tests**

Cover:
- A completion → persisted `PendingTransfer` before prepare side effect;
- target conversation changed before prepare → `conversation-changed`;
- target changes between prepare and commit → commit prohibited (Review Focus #2);
- target wait persists `causedByTransferId` before commit;
- committed transfer persists exact `targetUserMessageId` / `causedByUserMessageId`;
- completion that only echoes transfer ID but has wrong user ancestry is rejected;
- target completion before commit acknowledgement/user binding is later accepted from buffer;
- turn increments only after commit;
- `maxTurns = 10` blocks creation of transfer 11;
- stale wait/transfer/session event cannot advance state.

- [ ] **Step 2: Run RED**

Run: `npm test -- tests/background/relay-controller-transfer.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement automated transfer path**

Every external await must be followed by queued persisted-state reread/revalidation before mutation.

- [ ] **Step 4: Run GREEN**

Run: `npm test -- tests/background/relay-controller-transfer.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/background/relay-controller.ts tests/background/relay-controller-transfer.test.ts
git commit -m "feat: relay causally bound peer turns"
```

---

### Task 11: Stop Linearization and In-Flight Reconciliation

**Files:**
- Modify: `src/background/relay-controller.ts`
- Create: `tests/background/relay-controller-stop.test.ts`

**Responsibilities:**
- Implement the already-approved `stopping` contract without redesign.
- Prevent new transfer creation/authorization after Stop acceptance.
- Reconcile exactly one already-authorized transfer if it crossed commit.
- Never let stale async work restore waiting/dispatching state.

**Interfaces:**
- Consumes: Task 10 controller and transport `cancelSubmission`.
- Produces:
  - `stop(sessionId: string): Promise<RelaySession>`
  - `handleCancellationResult(...): Promise<void>`

- [ ] **Step 1: Write RED race tests**

Cover:
- Stop with no in-flight transfer → stopped;
- Stop during prepare before authorization → cancel and stopped;
- Stop after authorization but before commit → cancel if provable;
- Stop after commit → reconcile one transfer, no next transfer;
- ambiguous commit state → error;
- Stop vs assistant-complete;
- Stop vs transfer acknowledgement;
- stale continuation cannot overwrite stopped/error (Review Focus #4).

- [ ] **Step 2: Run RED**

Run: `npm test -- tests/background/relay-controller-stop.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement Stop/reconciliation**

Do not alter the Design linearization point or commit-point semantics.

- [ ] **Step 4: Run GREEN**

Run: `npm test -- tests/background/relay-controller-stop.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/background/relay-controller.ts tests/background/relay-controller-stop.test.ts
git commit -m "feat: reconcile relay stop safely"
```

---

### Task 12: Reload, Service-Worker Recovery, and Conversation Reconciliation

**Files:**
- Modify: `src/background/relay-controller.ts`
- Create: `tests/background/relay-controller-recovery.test.ts`

**Responsibilities:**
- Reconstruct state from storage after service-worker wake.
- Reconcile same conversation/message/wait/transfer identity.
- Reject different/unknown bound conversation.
- Re-arm only the persisted wait, never synthesize a new wait around current DOM.
- Reconcile committed/ambiguous transfer without blind retry.

**Interfaces:**
- Consumes: Tasks 3, 5, 8–11.
- Produces:
  - `recoverTab(tabId: number): Promise<RelaySession | null>`
  - `recoverActiveSession(): Promise<RelaySession | null>`

- [ ] **Step 1: Write RED recovery tests**

Cover:
- same bound conversation + same accepted message → resume without re-relay;
- different conversation after reload → error;
- bound identity unavailable when needed → error;
- new-chat unbound may bind only under first-allowed-prompt authority, not reload alone;
- persisted wait is re-armed with same `waitId` and `causedByUserMessageId`;
- interrupted committed transfer with exact user-message evidence reconciles once;
- ambiguous transfer status fails closed;
- stale worker continuation cannot overwrite newer persisted revision.

- [ ] **Step 2: Run RED**

Run: `npm test -- tests/background/relay-controller-recovery.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement recovery paths**

No automatic resend is allowed.

- [ ] **Step 4: Run GREEN**

Run: `npm test -- tests/background/relay-controller-recovery.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/background/relay-controller.ts tests/background/relay-controller-recovery.test.ts
git commit -m "feat: recover relay sessions safely"
```

---

### Task 13: Content-Script and Service-Worker Runtime Wiring

**Files:**
- Modify: `src/content/index.ts`
- Modify: `src/background/service-worker.ts`
- Create: `tests/integration/runtime-routing.test.ts`

**Responsibilities:**
- Instantiate one `ChatGPTAdapter` per eligible page.
- Parse/validate every inbound extension message.
- Derive sender tab from Chrome sender metadata.
- Route Chrome `runtime.onMessage`, `tabs.onRemoved`, and `tabs.onUpdated` events to the controller.
- Detect Split View invalidation and same-origin conversation/navigation recovery triggers.
- Keep authority in the controller, not runtime wrappers.

**Interfaces:**
- Consumes: Tasks 2, 4, 8–12.
- Produces:
  - production MV3 event wiring.
  - testable `createServiceWorkerRuntime(deps)` and `createContentRuntime(deps)` factories, or equivalent dependency-injected initialization functions.

- [ ] **Step 1: Write RED routing tests**

Cover:
- malformed message dropped;
- sender-supplied tab ID is ignored in favor of Chrome sender metadata;
- old session/wait messages reach controller but cannot mutate due to controller validation;
- `tabs.onRemoved` invokes fail-closed handling;
- `tabs.onUpdated(changeInfo.splitViewId)` invalidates pair when required;
- content runtime forwards transcript-interference event;
- no non-chatgpt content runtime path exists.

- [ ] **Step 2: Run RED**

Run: `npm test -- tests/integration/runtime-routing.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement service-worker and content runtime wiring**

Do not put selectors or state-machine mutations in the wrappers.

- [ ] **Step 4: Run GREEN**

Run: `npm test -- tests/integration/runtime-routing.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/background/service-worker.ts src/content/index.ts tests/integration/runtime-routing.test.ts
git commit -m "feat: wire Chrome relay runtimes"
```

---

### Task 14: Popup Start/Stop/maxTurns/Status Surface

**Files:**
- Modify: `src/popup/popup.html`
- Modify: `src/popup/popup.ts`
- Create: `tests/integration/popup.test.ts`

**Responsibilities:**
- Show valid-pair/session state.
- Start and Stop through controller messages only.
- Configure persisted default `maxTurns`.
- Show `waiting-*`, `dispatching-*`, `stopping`, `stopped`, and actionable error reason.
- Own no relay state.

**Interfaces:**
- Consumes: Task 2 messages and Task 13 runtime.
- Produces popup message requests:
  - `relay-status`
  - `relay-start`
  - `relay-stop`
  - `relay-preferences-get/set`
  if these names are not already present, add them to Task 2 protocol without altering domain semantics.

- [ ] **Step 1: Write RED popup tests**

Cover:
- Start disabled when pair invalid;
- maxTurns defaults to 10 and persists;
- Stop requests current session only;
- `stopping` is visibly distinct from `stopped`;
- machine-readable error gets an actionable user-facing explanation;
- Review Focus #5: closing/recreating popup reconstructs status and does not mutate session.

- [ ] **Step 2: Run RED**

Run: `npm test -- tests/integration/popup.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement minimal popup UI**

No role templates, prompt editor, history export, or future-phase controls.

- [ ] **Step 4: Run GREEN**

Run: `npm test -- tests/integration/popup.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/popup src/shared/protocol.ts tests/integration/popup.test.ts
git commit -m "feat: add relay control popup"
```

---

### Task 15: Browser Integration Harness and End-to-End Protocol Fixtures

**Files:**
- Create: `playwright.config.ts`
- Create: `tests/integration/extension-browser.spec.ts`
- Create: `tests/integration/harness/chat-page.html`
- Create: `tests/integration/harness/chat-page.ts`
- Modify: `package.json`
- Modify: `scripts/build.mjs`

**Responsibilities:**
- Load `dist/` as an unpacked extension in Chromium.
- Exercise extension runtime wiring against deterministic local ChatGPT-like fixture pages where real account/network state is not required.
- Verify service-worker wake/reload behavior at browser level.
- Keep real `chatgpt.com` account testing as manual smoke only.

**Interfaces:**
- Consumes: all prior tasks.
- Produces npm script `test:browser`.

- [ ] **Step 1: Write RED browser tests**

At minimum:
- extension loads with manifest contract intact;
- content script activates only when fixture URL is mapped through the intended test harness and production matching logic remains chatgpt-only;
- two simulated tab contexts can exchange protocol events through the real service worker;
- worker restart/reload does not lose persisted session state;
- stale continuation cannot overwrite a newer stop/error state;
- transcript interference event stops a relay rather than forwarding unrelated completion.

Use a harness abstraction; do not weaken production host permissions to make tests easier.

- [ ] **Step 2: Run RED**

Run: `npm run test:browser`

Expected: FAIL until harness/config exists.

- [ ] **Step 3: Implement Playwright persistent-context extension harness**

Use Chromium extension loading supported by Playwright. Do not add remote test services.

- [ ] **Step 4: Run GREEN**

Run:
```bash
npm run build
npm run test:browser
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add playwright.config.ts tests/integration/harness tests/integration/extension-browser.spec.ts package.json package-lock.json scripts/build.mjs
git commit -m "test: add browser relay integration coverage"
```

---

### Task 16: Full Verification and Current ChatGPT Manual Smoke Validation

**Files:**
- Modify only if verification exposes implementation-detail defects within the approved Design.
- Do not change Design architecture during this task.

**Responsibilities:**
- Prove automated coverage as a whole.
- Perform the required real `chatgpt.com` smoke check for current DOM compatibility.
- Stop and return to Design Review if the current site cannot provide the causal/conversation evidence required by the approved architecture.

**Interfaces:**
- Consumes: complete implementation.
- Produces: verification evidence only; no new public interface.

- [ ] **Step 1: Run all deterministic checks**

Run:
```bash
npm run build
npm test
npm run test:browser
```

Expected: all PASS, no skipped correctness tests for the Design acceptance criteria.

- [ ] **Step 2: Load `dist/` as an unpacked extension in Chrome 145+**

Verify the installed extension requests only:
- `storage`
- `https://chatgpt.com/*`

No forbidden permission may appear.

- [ ] **Step 3: Manual smoke — normal two-tab relay**

With two logged-in ChatGPT tabs in one native Split View:
1. make the intended initiator active;
2. Start relay;
3. manually submit the initial A prompt;
4. verify A completion relays exactly once to B;
5. verify B completion relays exactly once to A;
6. verify no streamed partial response is relayed;
7. Stop before `maxTurns` and confirm no new transfer is authorized.

- [ ] **Step 4: Manual smoke — fail-closed cases**

Verify:
- switch B to another ChatGPT conversation before next dispatch → `conversation-changed`, no submission;
- type unexpected text in target composer → no overwrite, fail closed;
- during an active automated wait, perform an unexpected manual submit or regenerate/edit/branch action that changes ancestry → relay stops/fails closed;
- close/remove one tab from Split View → relay stops/fails closed;
- reload a bound conversation → resume only if identity/reconciliation remains provable.

- [ ] **Step 5: Validate exact current DOM selector assumptions**

If any selector/probe fails, update only `dom-contract.ts` and fixtures/tests, rerun full verification, and repeat smoke.

If current ChatGPT DOM does not expose enough evidence to satisfy:
- exact relay-created user-turn identity,
- immutable conversation binding,
- transcript ancestry,
then **do not weaken the protocol**. Stop and return to Design Review with the missing evidence.

- [ ] **Step 6: Final full verification**

Run again:
```bash
npm run build
npm test
npm run test:browser
```

Expected: all PASS after any selector-only adjustment.

- [ ] **Step 7: Commit verification-only implementation-detail fixes, if any**

If no files changed during smoke validation, do not create an empty commit.

If selector/fixture fixes were required:

```bash
git add src/content/dom-contract.ts tests/content/dom-contract.test.ts tests/content/fixtures
git commit -m "fix: align ChatGPT DOM contract"
```

---

## Implementation Completion Gate

Implementation is not complete until all Design acceptance criteria are represented by passing automated tests or the explicitly required manual current-site smoke checks.

Before claiming implementation complete:

1. Run `npm run build`.
2. Run `npm test`.
3. Run `npm run test:browser`.
4. Confirm manifest permissions exactly match the Design.
5. Confirm current `chatgpt.com` manual smoke validation passed.
6. Confirm no production file contains ChatGPT selectors outside `src/content/dom-contract.ts`.
7. Confirm no relay state is owned by popup code or module-global service-worker variables.
8. Confirm no automatic retry exists for ambiguous committed submissions.
9. Confirm no implementation widened the Design-approved browser/security/protocol boundaries.

If any approved Design invariant cannot be implemented against the current ChatGPT DOM, stop and return to Design Review instead of inventing a weaker protocol.
