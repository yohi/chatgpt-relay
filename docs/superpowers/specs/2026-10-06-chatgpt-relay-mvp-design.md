# ChatGPT Relay MVP Design

Date: 2026-10-06
Status: Design baseline — awaiting user review
Scope: Chrome extension MVP

## 1. Purpose

ChatGPT Relay connects two ChatGPT web sessions displayed side by side in Chrome Split View and automatically relays each completed assistant response to the peer session.

The user remains able to observe both conversations directly in the browser, stop the relay at any time, and give the two ChatGPT sessions different roles or instructions.

The MVP targets `chatgpt.com` only and does not depend on OpenAI API access or undocumented backend APIs.

## 2. Goals

The MVP must:

1. Detect the two `chatgpt.com` tabs belonging to the same Chrome Split View.
2. Pair those tabs as side A and side B.
3. Observe completed assistant responses in either tab.
4. Relay a completed response from A to B and then from B to A.
5. Avoid relaying partial streamed output.
6. Prevent duplicate relay of the same assistant response.
7. Stop automatically at a configured maximum turn count.
8. Provide an explicit user-controlled Stop action.
9. Fail closed when the ChatGPT UI cannot be recognized safely.
10. Survive Manifest V3 service worker suspension by persisting relay state outside in-memory globals.

## 3. Non-goals

The MVP does not include:

- OpenAI API execution.
- Support for providers other than ChatGPT.
- More than two peer sessions.
- Automated model selection.
- Prompt-template libraries.
- Conversation-history export.
- Automatic Split View creation through `chrome.tabs.createSplit()`.
- CAPTCHA, login, access-control, or error-page bypass.
- Direct dependence on ChatGPT internal React state or undocumented network protocols.

Automatic Split View creation may be considered after Chrome 155+ is an acceptable minimum target.

## 4. User flow

The MVP flow is:

1. The user opens two ChatGPT tabs.
2. The user places them in one Chrome Split View.
3. The user establishes any role-specific instructions independently in the two sessions.
4. The user focuses the ChatGPT tab that should initiate the relay and starts ChatGPT Relay.
5. The focused eligible tab becomes A; the other eligible tab in the same Split View becomes B.
6. The user sends the initial task to A manually.
7. After A finishes generating, the extension captures the completed assistant response.
8. The extension sends that response to B inside a relay envelope.
9. After B finishes generating, the extension captures B's completed assistant response.
10. The extension sends that response back to A.
11. Steps 7-10 repeat until Stop, `maxTurns`, or an error condition ends the relay.

The extension does not own the initial task prompt in the MVP.

The Start action is valid only when the currently active tab is an eligible `chatgpt.com` tab in a valid two-tab Split View pair. This makes A/B assignment deterministic without depending on an unavailable or fragile notion of visual left/right position.

## 5. Architecture

The extension is divided into four responsibilities:

```text
┌─────────────────────────────────────────┐
│ Popup                                   │
│ Start / Stop / maxTurns / pair status   │
└──────────────────┬──────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────┐
│ Relay Controller                        │
│ Manifest V3 Service Worker              │
│                                         │
│ IDLE → WAIT_A → WAIT_B → WAIT_A ...     │
│          │          │                   │
│          └── stop/error/max → STOPPED   │
└──────────────┬─────────────────┬────────┘
               │                 │
               ▼                 ▼
       ChatGPT Adapter A   ChatGPT Adapter B
       Content Script      Content Script
               │                 │
               ▼                 ▼
          ChatGPT DOM        ChatGPT DOM
```

### 5.1 Popup

The popup is a thin control surface.

Responsibilities:

- Display whether a valid ChatGPT Split View pair is available.
- Start a new relay session.
- Stop the active relay session.
- Configure `maxTurns`.
- Display the active turn and current waiting side.
- Surface an actionable error state.

The popup does not inspect or manipulate the ChatGPT DOM directly.

### 5.2 Relay Controller

The service worker owns relay orchestration.

Responsibilities:

- Discover and validate the A/B tab pair.
- Persist relay-session state.
- Receive completed-response events from content scripts.
- Validate that an event is expected for the current relay state.
- Construct the peer relay command.
- Advance the state machine.
- Enforce `maxTurns`.
- Stop on tab closure, invalid navigation, adapter failure, or explicit user action.
- Reject stale, duplicate, or out-of-order events.

The controller must not contain ChatGPT CSS selectors or DOM knowledge.

### 5.3 ChatGPT Adapter

Each ChatGPT tab runs a content script containing a `ChatGPTAdapter`.

Conceptual interface:

```ts
interface ChatGPTAdapter {
  getState(): ChatState;
  submit(text: string): Promise<void>;
  waitForCompletion(): Promise<AssistantResponse>;
  getLatestAssistantResponse(): AssistantResponse | null;
}
```

The adapter is the sole owner of ChatGPT DOM knowledge.

It is responsible for:

- Finding the prompt editor.
- Determining whether the page is ready for interaction.
- Detecting whether ChatGPT is currently generating.
- Inserting relay text without overwriting unexpected user input.
- Triggering a normal UI submission.
- Observing assistant-message changes.
- Detecting stable generation completion.
- Returning normalized assistant-response content.
- Producing a stable message identity or fingerprint.

All selectors and ChatGPT-specific heuristics must remain inside this layer so DOM changes do not leak into relay orchestration.

## 6. Split View pairing

The MVP requires Chrome 140+ behavior sufficient to inspect `Tab.splitViewId`.

A valid pair is exactly two eligible `chatgpt.com` tabs in the same browser window that share the same non-default Split View identifier.

A is the currently active eligible ChatGPT tab at Start time. B is the other eligible ChatGPT tab sharing the same Split View identifier.

The controller must reject:

- Zero or one eligible tab.
- More than two eligible tabs associated with the candidate pair.
- Tabs in different windows.
- A tab no longer on an allowed ChatGPT origin.
- A pair whose Split View relationship disappears before relay start.

The MVP does not create the Split View itself.

## 7. Relay protocol

A relay message is not inserted as unlabelled raw text.

The MVP uses a fixed envelope:

```text
The following message was produced by the peer ChatGPT session.

--- PEER RESPONSE ---
{response}
--- END PEER RESPONSE ---

Respond to the peer according to the instructions already established
in this conversation.
```

This keeps the extension role-neutral. The user defines roles such as implementation, review, debate, or refinement inside each ChatGPT conversation.

The envelope itself is static in the MVP.

### 7.1 Canonical relay payload

The MVP relays text only.

The adapter extracts user-visible assistant text into a normalized plain-text payload that preserves meaningful line breaks and code-block text but never relays executable HTML or page markup.

Images, generated files, interactive widgets, and other non-text assistant artifacts are outside the MVP. If an assistant response contains no relayable text, the session stops with an actionable error rather than sending an empty or guessed representation.

## 8. Completion detection

Streaming output must never be relayed as if it were complete.

The adapter considers a response complete only after all required conditions hold:

1. An assistant response associated with the current expected turn exists.
2. The response is no longer visibly changing.
3. ChatGPT is no longer in its active generation state.
4. The response content remains stable for a debounce interval.
5. The response has not already been emitted as complete.

A `MutationObserver` may be used as a change signal, but a DOM mutation alone is never completion evidence.

The implementation should prefer multiple independent completion signals over a single fragile selector.

## 9. Duplicate suppression and message identity

Every emitted assistant response receives a relay identity.

The identity should incorporate the strongest stable evidence available, such as:

- tab identity,
- conversation/page identity when available,
- assistant-message identity when available,
- normalized assistant-response content.

If ChatGPT does not expose a stable message identifier in the DOM, the adapter may derive a deterministic content fingerprint.

The Relay Controller records the last accepted message identity for each side and rejects duplicates.

A page reload must not cause the same already-relayed response to be emitted again.

## 10. State machine

The conceptual relay session is:

```ts
type RelayState =
  | "idle"
  | "waiting-a"
  | "dispatching-b"
  | "waiting-b"
  | "dispatching-a"
  | "stopped"
  | "error";

type PendingTransfer = {
  id: string;
  sourceTabId: number;
  targetTabId: number;
  sourceMessageId: string;
  payloadHash: string;
};

type RelaySession = {
  id: string;
  splitViewId: number;
  tabA: number;
  tabB: number;
  state: RelayState;
  turn: number;
  maxTurns: number;
  lastMessageA?: string;
  lastMessageB?: string;
  pendingTransfer?: PendingTransfer;
  stopReason?: string;
};
```

Semantics:

- `idle`: no active relay.
- `waiting-a`: only a newly completed response from A is accepted.
- `dispatching-b`: an A response has been accepted and exactly one transfer to B is being reconciled.
- `waiting-b`: only a newly completed response from B is accepted.
- `dispatching-a`: a B response has been accepted and exactly one transfer to A is being reconciled.
- `stopped`: relay ended normally or by explicit user action.
- `error`: relay stopped because continuing safely is not possible.

The initial active state after Start is `waiting-a`.

When a completed source response is accepted, the controller first persists a `PendingTransfer` and moves to the appropriate `dispatching-*` state. Only then may it command the target adapter to submit.

The target adapter returns a transfer acknowledgement only after it has performed and confirmed the UI submission. After that acknowledgement is persisted, the controller increments `turn`, clears `pendingTransfer`, and moves to the peer `waiting-*` state.

A missing acknowledgement is never grounds for blind retransmission. If the service worker, tab, or content script is interrupted during the dispatch window, recovery must inspect target-page evidence and either reconcile the transfer as already submitted or stop with `error` when the result is ambiguous.

Unexpected-side events are ignored or rejected and must not advance the state machine.

## 11. Turn counting

One relay transfer counts as one turn.

Example:

```text
A → B : turn 1
B → A : turn 2
A → B : turn 3
```

The default `maxTurns` is 10.

The controller must stop before creating a `PendingTransfer` that would exceed `maxTurns`.

The turn counter increments only after the target submission is confirmed.

This definition avoids ambiguity between "round", "exchange", and "message".

## 12. Persistence

Manifest V3 service workers may be suspended between events.

Therefore active relay correctness must not depend on module-level JavaScript variables.

Use:

- `chrome.storage.session` for active relay-session state that only needs to survive service-worker suspension within the browser session.
- `chrome.storage.local` for durable user preferences such as the default `maxTurns`.

When the service worker wakes, it must reconstruct the active relay session from persisted state before handling relay events.

## 13. Messaging

Extension contexts communicate using Chrome extension messaging.

Message types should be explicit and versionable, for example:

```ts
type RelayMessage =
  | { type: "adapter-ready"; tabId: number }
  | { type: "assistant-complete"; tabId: number; message: AssistantResponse }
  | { type: "submit-peer-response"; sessionId: string; transferId: string; text: string }
  | { type: "transfer-submitted"; sessionId: string; transferId: string }
  | { type: "relay-start" }
  | { type: "relay-stop"; reason: string };
```

All inbound messages must be validated.

The service worker must verify sender tab identity before accepting adapter events.

The content script must verify that a submission command belongs to the currently active session and intended tab.

## 14. User-input protection

The extension must not silently overwrite user-composed text.

Before submitting a relayed response, the adapter must confirm that the prompt editor is in a safe state.

If unexpected user text is already present, the relay stops with an actionable error rather than replacing or appending to it automatically.

The extension must also refuse to submit while the target ChatGPT tab is already generating a response.

## 15. Failure handling

The relay stops safely when any of the following occurs:

- One paired tab is closed.
- One paired tab navigates away from an allowed ChatGPT origin.
- The Split View pair becomes invalid.
- The prompt editor cannot be identified.
- The adapter cannot determine generation state safely.
- The target prompt contains unexpected user text.
- Submission cannot be confirmed.
- A stale or invalid session command is received.
- The active response cannot be identified reliably.
- `maxTurns` is reached.
- The user presses Stop.

The controller records a machine-readable stop reason and exposes a user-readable explanation through the popup.

No automatic retry may create a duplicate user-visible ChatGPT message.

Submission commands are identified by `transferId`. A target adapter must reject a duplicate command it can prove it has already applied. If it cannot prove whether a prior interrupted command was applied, it must not guess; the controller reconciles visible page state or stops the session.

## 16. Reload and resynchronization

A ChatGPT tab reload must not automatically resume by replaying the last peer message.

After reload:

1. The content script announces readiness.
2. The controller checks whether the tab belongs to the persisted active session.
3. The adapter reports the latest visible assistant-message identity, current generation state, and any evidence relevant to a persisted `PendingTransfer`.
4. The controller compares that evidence with persisted state.
5. A dispatch interrupted after visible submission but before acknowledgement is reconciled as submitted only when target-page evidence is unambiguous.
6. Relay resumes only if state can be reconciled without ambiguity.

If reconciliation is ambiguous, the session transitions to `error` and requires the user to restart.

Safety is preferred over automatic continuation.

## 17. Security and permissions

The extension should request the minimum permissions needed by the MVP.

Expected capabilities include:

- tab metadata sufficient for Split View discovery,
- extension storage,
- content-script access restricted to supported ChatGPT origins.

The MVP must not:

- execute remotely hosted JavaScript,
- evaluate downloaded code,
- expose a general-purpose page-to-extension command channel,
- trust arbitrary page-provided data as control instructions,
- inject into unrelated sites.

Content-script inputs from the page are treated as untrusted observations, not authority over relay state.

## 18. Proposed repository structure

```text
chatgpt-relay/
├── manifest.json
├── package.json
├── tsconfig.json
├── src/
│   ├── background/
│   │   └── service-worker.ts
│   ├── content/
│   │   ├── index.ts
│   │   └── chatgpt-adapter.ts
│   ├── popup/
│   │   ├── popup.html
│   │   └── popup.ts
│   └── shared/
│       ├── messages.ts
│       └── types.ts
├── tests/
│   ├── relay-controller/
│   └── chatgpt-adapter/
└── docs/
    └── superpowers/
        └── specs/
```

Exact build tooling is intentionally deferred to the implementation plan.

## 19. Testing strategy

Testing is split by boundary.

### 19.1 Relay Controller unit tests

Use pure state-transition tests with mocked extension I/O.

Cover at minimum:

- valid A → B transition,
- valid B → A transition,
- unexpected-side event rejection,
- duplicate response rejection,
- stale session rejection,
- `maxTurns` enforcement,
- explicit Stop,
- tab closure,
- invalid navigation,
- service-worker reconstruction from persisted state.

### 19.2 ChatGPT Adapter tests

DOM fixtures should test ChatGPT-facing behavior without requiring the real site for every case.

Cover at minimum:

- prompt editor discovery,
- generation-state detection,
- assistant-message extraction,
- stream-to-stable completion detection,
- duplicate-completion suppression,
- refusal to overwrite user input,
- submission failure handling,
- selector fallback behavior.

### 19.3 Browser integration tests

A small integration layer should verify extension wiring in Chromium.

Because the real ChatGPT UI and account state are external and mutable, deterministic automated tests should primarily use controlled fixtures or a test harness.

Manual smoke testing against `chatgpt.com` is still required before release because DOM compatibility cannot be fully proven by fixtures.

## 20. MVP acceptance criteria

The MVP is accepted when all of the following are demonstrated:

1. With two logged-in ChatGPT tabs in one Split View, Start identifies a valid pair.
2. After the user manually submits an initial task to A, A's completed response is relayed exactly once to B.
3. B's completed response is relayed exactly once to A.
4. Partial streamed text is never submitted to the peer.
5. The relay continues alternating without duplicate messages.
6. Pressing Stop prevents any subsequent automatic submission.
7. Reaching `maxTurns` prevents the next transfer.
8. User text already present in the target editor is never overwritten.
9. Closing or navigating one paired tab stops the session safely.
10. Service-worker suspension does not lose active relay state.
11. A DOM recognition failure stops the relay instead of guessing.
12. The relay controller contains no ChatGPT-specific DOM selectors.
13. An interrupted dispatch is never blindly resubmitted when prior submission status is ambiguous.
14. The active tab at Start is deterministically assigned as A and the paired tab as B.

## 21. Future phases

Potential follow-up work, explicitly outside the MVP:

### Phase 2

- Chrome 155+ automatic Split View creation.
- Optional one-click creation of the second ChatGPT tab.
- Configurable relay envelope.
- Better session recovery diagnostics.

### Phase 3

- Additional web-based AI providers behind provider adapters.
- Multiple relay modes such as reviewer, debate, and refinement.
- More than two agents, if a concrete use case justifies the added orchestration complexity.

These phases must not complicate the MVP architecture prematurely.
