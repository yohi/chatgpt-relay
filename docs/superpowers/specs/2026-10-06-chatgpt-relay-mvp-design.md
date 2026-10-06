# ChatGPT Relay MVP Design

Date: 2026-10-06
Status: Design baseline — review fixes applied; awaiting fresh review
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
│ IDLE → WAIT_A → DISPATCH_B → WAIT_B     │
│          ▲                    │          │
│          └── DISPATCH_A ◀─────┘          │
│                 │                        │
│      stop → STOPPING → STOPPED           │
│      ambiguity/failure → ERROR           │
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

Conceptual protocol-facing types:

```ts
type Side = "a" | "b";

type AssistantResponse = {
  messageId: string;
  text: string;
  textHash: string;
};

type AdapterSnapshot = {
  ready: boolean;
  generating: boolean;
  conversationIdentity: string | null;
  latestAssistant: AssistantResponse | null;
};

type PreparedSubmission = {
  transferId: string;
  waitId: string;
  baselineMessageId: string | null;
};

interface ChatGPTAdapter {
  inspect(): Promise<AdapterSnapshot>;

  armExpectedResponse(expected: ExpectedResponse): Promise<void>;

  prepareSubmission(input: {
    sessionId: string;
    transferId: string;
    waitId: string;
    text: string;
  }): Promise<PreparedSubmission>;

  commitSubmission(input: {
    sessionId: string;
    transferId: string;
    waitId: string;
    authorizationRevision: number;
  }): Promise<"committed">;

  cancelSubmission(input: {
    sessionId: string;
    transferId: string;
  }): Promise<"cancelled-before-commit" | "already-committed" | "unknown">;
}
```

The adapter is the sole owner of ChatGPT DOM knowledge.

It is responsible for:

- Finding the prompt editor.
- Determining whether the page is ready for interaction.
- Detecting whether ChatGPT is currently generating.
- Extracting the latest assistant-message identity and canonical text.
- Capturing a response baseline before a wait is armed.
- Installing completion observation before an automated target submission can begin.
- Buffering a completed response for an armed `waitId` until the controller is ready to receive it.
- Inserting relay text without overwriting unexpected user input.
- Triggering a normal UI submission.
- Defining and reporting the submission commit point.
- Detecting stable generation completion.
- Producing a stable message identity according to §9.
- Rejecting stale, duplicate, or mismatched session/transfer/wait commands.

All selectors and ChatGPT-specific heuristics must remain inside this layer so DOM changes do not leak into relay orchestration.

The adapter must never emit an `assistant-complete` event merely because a completed assistant node exists. It may emit completion only for an explicitly armed `ExpectedResponse` whose baseline and causal identifiers match.

## 6. Split View pairing and browser baseline

The MVP supports **Chrome 145 and later** because Chrome 145 is the minimum supported release in which the user-facing native Chrome Split View required by this MVP is available.

`Tab.splitViewId` and `tabs.onUpdated.changeInfo.splitViewId` exist from Chrome 140, but API property availability alone does not make Chrome 140–144 supported MVP runtimes.

The manifest must therefore declare:

```json
{
  "minimum_chrome_version": "145"
}
```

A valid pair is exactly two eligible `chatgpt.com` tabs in the same browser window that share the same non-default Split View identifier.

A is the currently active eligible ChatGPT tab at Start time. B is the other eligible ChatGPT tab sharing the same Split View identifier.

The controller must reject:

- Zero or one eligible tab.
- More than two eligible tabs associated with the candidate pair.
- Tabs in different windows.
- A tab no longer on an allowed ChatGPT origin.
- A pair whose Split View relationship disappears before relay start.
- A Start request when A is already generating.

During an active relay, `tabs.onUpdated` changes to `splitViewId` are authoritative pairing-change signals. If either paired tab changes to `SPLIT_VIEW_ID_NONE` or no longer shares the persisted pair identifier, the controller enters failure handling and authorizes no new transfer.

The MVP does not create the Split View itself. `chrome.tabs.createSplit()` remains Phase 2 and requires Chrome 155+.

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

## 8. Expected-response protocol and completion detection

Streaming output must never be relayed as if it were complete, and a completed DOM node must never be accepted without an explicit causal wait.

The persisted causal contract is:

```ts
type ExpectedResponse = {
  sessionId: string;
  waitId: string;
  side: "a" | "b";
  tabId: number;
  baselineMessageId: string | null;
  causedByTransferId?: string;
};
```

Every accepted completion is bound to exactly one `sessionId + waitId`.

An `assistant-complete` event is valid only when:

1. its `sessionId` equals the currently persisted relay session;
2. its `waitId` equals the currently persisted `ExpectedResponse.waitId`;
3. its sender tab and side match the persisted expected tab and side;
4. its message is strictly after the persisted response baseline;
5. for an automated target response, `causedByTransferId` matches the transfer that caused that wait;
6. the message has not already been accepted for that wait.

A stale or unknown `waitId`, an old `sessionId`, or a mismatched transfer binding must not advance the state machine.

### 8.1 Initial A ordering

Start has the following normative ordering:

```text
1. receive Start request
2. validate the Split View pair and assign active tab = A
3. confirm A adapter readiness
4. confirm A is not currently generating; otherwise reject Start
5. inspect A and capture the latest assistant message identity as baseline
6. generate sessionId and waitId
7. persist RelaySession + ExpectedResponse(A, waitId, baseline)
8. arm A adapter with that exact ExpectedResponse
9. confirm the arm succeeded
10. report Start success to the popup/user
11. user manually submits the initial task to A
12. only an assistant message strictly after baseline may complete waitId
```

An assistant response that existed before Start can therefore never satisfy the initial wait.

### 8.2 Automated target ordering

For A → B or B → A, completion observation must exist before the UI submission can produce a target response.

The normative protocol is:

```text
controller:
  accept source completion for current ExpectedResponse
  persist PendingTransfer and dispatching-target state
  ↓
target adapter prepareSubmission:
  validate editor/generation safety
  capture target latest-assistant baseline
  install/bind completion observation for target waitId
  stage the relay text without submitting it
  return PreparedSubmission
  ↓
controller:
  re-read and revalidate persisted session
  persist target ExpectedResponse(waitId, baseline, causedByTransferId)
  persist dispatch authorization revision
  ↓
target adapter commitSubmission:
  revalidate session/transfer/wait identifiers
  cross the defined submission commit point
  trigger normal ChatGPT UI submission
  return committed
  response completion may occur at any point after commit;
  if controller is not yet ready, adapter buffers it by waitId
  ↓
controller:
  re-read and revalidate persisted session
  persist turn increment and waiting-target state
  arm/confirm receipt path for the target ExpectedResponse
  ↓
target adapter:
  if completion was already buffered for waitId, emit it immediately
  otherwise emit it when completion conditions become true
```

No implementation may use an ordering in which a valid target completion can be discarded solely because it arrived before the submission acknowledgement was processed.

### 8.3 Completion evidence

For the armed response, the adapter considers generation complete only after all required conditions hold:

1. an assistant response strictly after the armed baseline exists;
2. the response is no longer visibly changing;
3. ChatGPT is no longer in its active generation state;
4. the response content remains stable for a debounce interval;
5. the response identity satisfies §9;
6. the response has not already been emitted for that `waitId`.

A `MutationObserver` may be used as a change signal, but a DOM mutation alone is never completion evidence.

The implementation should prefer multiple independent completion signals over a single fragile selector.

## 9. Duplicate suppression and message identity

Message identity is distinct from content identity. Two different assistant turns are allowed to contain exactly the same text and must still be relayed independently.

The conceptual response shape is:

```ts
type AssistantResponse = {
  messageId: string;
  text: string;
  textHash: string;
};
```

`textHash` is a deterministic hash of normalized relay text. It is evidence about content, not by itself a persistent message identity.

The adapter uses this identity precedence:

1. **Verified stable DOM identity.** If ChatGPT exposes a per-message identifier that the adapter can verify as stable for the same transcript message across a normal re-read/reload, `messageId` uses that identifier.
2. **Deterministic transcript fallback.** If no verified stable DOM identifier exists, `messageId` is derived from:
   - stable conversation identity,
   - stable assistant-message ordinal in the reconstructed transcript,
   - normalized content hash.
3. **Ambiguous reconstruction.** If reload or DOM state does not allow the conversation identity and transcript ordinal to be reconstructed safely, the adapter must not fall back to content hash alone. Recovery stops with `message-identity-ambiguous`.

`tabId + contentHash`, content hash alone, or another content-only key must never be used as persistent duplicate identity.

The assistant ordinal counts assistant messages in stable transcript order, not unique content values. Therefore two separate assistant messages containing `OK` have different identities even though their `textHash` values are equal.

The Relay Controller records the accepted message identity associated with each consumed `ExpectedResponse` and rejects a second acceptance of the same wait/message pair.

After reload, an already accepted visible assistant message must reconstruct to the same `messageId`; if that cannot be proven, the relay fails closed instead of guessing.

## 10. State machine, linearization, and transfer protocol

The conceptual relay session is:

```ts
type RelayState =
  | "idle"
  | "waiting-a"
  | "dispatching-b"
  | "waiting-b"
  | "dispatching-a"
  | "stopping"
  | "stopped"
  | "error";

type PendingTransfer = {
  id: string;
  sourceTabId: number;
  targetTabId: number;
  sourceMessageId: string;
  payloadHash: string;
  targetWaitId: string;
  targetBaselineMessageId?: string | null;
  authorizationRevision?: number;
  submissionState: "preparing" | "authorized" | "committed";
};

type RelaySession = {
  id: string;
  revision: number;
  splitViewId: number;
  tabA: number;
  tabB: number;
  state: RelayState;
  turn: number;
  maxTurns: number;
  expectedResponse?: ExpectedResponse;
  lastMessageA?: string;
  lastMessageB?: string;
  pendingTransfer?: PendingTransfer;
  stopReason?: string;
};
```

Semantics:

- `idle`: no active relay.
- `waiting-a`: exactly one persisted `ExpectedResponse` for A is armed.
- `dispatching-b`: an accepted A response owns one persisted transfer toward B.
- `waiting-b`: exactly one persisted `ExpectedResponse` for B is armed.
- `dispatching-a`: an accepted B response owns one persisted transfer toward A.
- `stopping`: Stop has been accepted; no new transfer may be authorized while any already-authorized transfer is cancelled or reconciled.
- `stopped`: relay has ended and no automatic submission may begin.
- `error`: relay stopped because continuing safely is not possible.

### 10.1 Single authoritative state writer

The Relay Controller is the single authoritative writer of `RelaySession`.

All events that may mutate relay state—including completion, transfer preparation/commit acknowledgement, Stop, tab close, navigation, Split View changes, timeout/recovery, and `maxTurns` handling—must pass through one serialized transition path within the current service-worker lifetime.

Every transition obeys this contract:

```text
1. enter the serialized transition path
2. read the latest RelaySession from chrome.storage.session
3. validate sessionId and the event-specific revision / transferId / waitId
4. derive the next state
5. persist the next state and increment revision
6. only then perform any external side effect authorized by that persisted state
7. after any await, re-enter the serialized path and re-read persisted state
8. revalidate identifiers and revision before any later mutation
9. a stale continuation must not write state
```

An in-memory queue or mutex may serialize handlers during one service-worker lifetime, but correctness must not depend on module-global RelaySession state. Persisted `revision` plus mandatory re-read/revalidation prevents an old async continuation from overwriting a newer `stopped`, `stopping`, or `error` transition.

`chrome.storage.session` is not treated as a transactional compare-and-swap store; revision is a protocol guard used together with the single-writer serialized transition path and revalidation.

### 10.2 Persist-before-side-effect

When a completed source response is accepted, the controller:

1. verifies that creating another transfer would not exceed `maxTurns`;
2. creates and persists `PendingTransfer`;
3. moves to the corresponding `dispatching-*` state;
4. increments `revision`;
5. only then instructs the target adapter to prepare/submit according to §8.2.

A side effect must never be the first durable evidence that a transfer exists.

A missing acknowledgement is never grounds for blind retransmission. Recovery must reconcile target-page evidence and persisted causal identifiers or fail closed.

### 10.3 Submission commit point

The adapter's **submission commit point** is the instant at which it invokes the ChatGPT UI action that can cause the staged prompt to be submitted (for example, the actual send-button activation or equivalent submit event).

Before that point, the staged operation is cancelable and must not be reported as committed.

After that point, the transfer is treated as potentially user-visible and must never be blindly repeated.

### 10.4 Stop semantics

A user Stop request is persisted by the controller as `stopping`. That transition is the linearization point after which:

- no new `PendingTransfer` may be created;
- no new transfer may be authorized;
- no newly completed peer response may start another transfer.

If there is no in-flight transfer, `stopping` immediately becomes `stopped`.

If a transfer is being prepared and no commit authorization has been issued, it is cancelled and the session becomes `stopped`.

If commit authorization has already been issued, the controller requests cancellation/reconciliation from the target adapter:

- if the adapter proves cancellation occurred before the submission commit point, the session becomes `stopped`;
- if the adapter reports or page evidence proves the commit point was crossed, that one transfer is reconciled but no response from it may cause another transfer; then the session becomes `stopped`;
- if commit status is ambiguous, the session becomes `error` rather than guessing or retrying.

The popup may show `stopping` while this reconciliation is in progress. It must report `stopped` only after the above contract is satisfied.

After the popup reports `stopped`, no automatic submission may begin.

Unexpected-side, stale-session, stale-revision, stale-`waitId`, or stale-`transferId` events must not advance the state machine.

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

- `chrome.storage.session` for the authoritative active `RelaySession`, including `revision`, `ExpectedResponse`, `PendingTransfer`, accepted message identities, and stop/error state.
- `chrome.storage.local` for durable user preferences such as the default `maxTurns`.

Before handling any state-mutating relay event after wake-up, the service worker must reconstruct the active session from `chrome.storage.session` and enter the serialized transition path defined in §10.1.

A service-worker restart must not reset `revision`, create a fresh wait for an existing response, or authorize a transfer that cannot be reconciled with persisted state.

## 13. Messaging

Extension contexts communicate using Chrome extension messaging.

Message types are explicit and causally scoped. Conceptually:

```ts
type RelayMessage =
  | {
      type: "adapter-ready";
      sessionId?: string;
      tabId: number;
    }
  | {
      type: "arm-response";
      expected: ExpectedResponse;
      authorizationRevision: number;
    }
  | {
      type: "assistant-complete";
      sessionId: string;
      waitId: string;
      causedByTransferId?: string;
      message: AssistantResponse;
    }
  | {
      type: "prepare-peer-response";
      sessionId: string;
      transferId: string;
      waitId: string;
      text: string;
      authorizationRevision: number;
    }
  | {
      type: "transfer-prepared";
      sessionId: string;
      transferId: string;
      waitId: string;
      baselineMessageId: string | null;
    }
  | {
      type: "commit-transfer";
      sessionId: string;
      transferId: string;
      waitId: string;
      authorizationRevision: number;
    }
  | {
      type: "transfer-committed";
      sessionId: string;
      transferId: string;
      waitId: string;
    }
  | {
      type: "cancel-transfer";
      sessionId: string;
      transferId: string;
    }
  | { type: "relay-start" }
  | { type: "relay-stop"; sessionId: string };
```

Exact serialization syntax may differ, but these causal fields and their semantics are normative.

All inbound messages must be structurally validated.

The service worker must derive and verify the sender tab from Chrome's message sender metadata rather than trusting a page-provided `tabId` as authority.

Before accepting an adapter event, the controller revalidates the latest persisted `sessionId`, `revision`, `waitId`, and/or `transferId` required by that event.

The content script must reject commands that do not belong to its intended tab/session or that replay an already-consumed transfer/wait authorization.

An `assistant-complete` message without the currently armed `sessionId + waitId` is never a relay event, even if the observed DOM message is new.

## 14. User-input protection

The extension must not silently overwrite user-composed text.

Before submitting a relayed response, the adapter must confirm that the prompt editor is in a safe state.

If unexpected user text is already present, the relay stops with an actionable error rather than replacing or appending to it automatically.

The extension must also refuse to submit while the target ChatGPT tab is already generating a response.

## 15. Failure handling

The relay stops safely when any of the following occurs:

- One paired tab is closed.
- One paired tab navigates away from an allowed ChatGPT origin.
- Either paired tab loses or changes the persisted Split View relationship.
- The prompt editor cannot be identified.
- The adapter cannot determine generation state safely.
- A Start request finds A already generating.
- The target prompt contains unexpected user text.
- Submission cannot be prepared or committed safely.
- A stale or invalid session/revision/wait/transfer command is received where recovery cannot safely ignore it.
- The active response cannot be identified reliably.
- Message identity cannot be reconstructed safely after reload.
- An interrupted transfer cannot be proven committed or cancelled.
- `maxTurns` is reached.
- The user presses Stop.

The controller records a machine-readable stop/error reason and exposes a user-readable explanation through the popup.

No automatic retry may create a duplicate user-visible ChatGPT message.

Submission commands are identified by `transferId`. A target adapter must reject a duplicate command it can prove it has already applied. If it cannot prove whether a prior interrupted command was applied, it must not guess; the controller reconciles visible page state or enters `error`.

A transition to `error`, `stopping`, or `stopped` is monotonic for that session: a stale async continuation may not restore a waiting or dispatching state.

## 16. Reload and resynchronization

A ChatGPT tab reload must not automatically resume by replaying the last peer message.

After reload:

1. The content script announces readiness.
2. The controller enters the serialized transition path and loads the latest persisted session.
3. The controller verifies that the tab still belongs to the persisted active pair.
4. The adapter reconstructs conversation identity, transcript message identities, latest assistant identity, current generation state, and any evidence relevant to a persisted `ExpectedResponse` or `PendingTransfer`.
5. An already accepted visible message must reconstruct to the same `messageId`; it is not emitted again.
6. If a persisted wait exists, the adapter may re-arm only that same `sessionId + waitId` against its persisted baseline; it must not synthesize a new wait around the latest DOM response.
7. A dispatch interrupted after visible submission but before acknowledgement is reconciled as submitted only when target-page evidence is unambiguous.
8. Relay resumes only if message identity, wait identity, transfer state, and Split View pairing can all be reconciled without ambiguity.

If transcript ordering/ordinal cannot be reconstructed safely, if the same message cannot be identified across reload, or if transfer commit status is ambiguous, the session transitions to `error`.

Content hash alone is never sufficient recovery evidence.

Safety is preferred over automatic continuation.

## 17. Security, browser, and manifest boundary

The MVP security boundary is fixed by this design and must not be broadened in the Implementation Plan without a design change and fresh review.

The normative manifest capability set is:

```json
{
  "manifest_version": 3,
  "minimum_chrome_version": "145",
  "permissions": [
    "storage"
  ],
  "host_permissions": [
    "https://chatgpt.com/*"
  ],
  "content_scripts": [
    {
      "matches": [
        "https://chatgpt.com/*"
      ]
    }
  ]
}
```

The final manifest will also contain normal non-security metadata and built asset paths, but the MVP must not add these permissions unless the design is reopened:

```text
"tabs"
"activeTab"
"scripting"
"<all_urls>"
"webRequest"
"debugger"
```

Rationale:

- Native Split View inspection through the Tabs API does not require a dedicated Split View permission.
- General Tabs API use does not itself require the `"tabs"` permission; that permission grants privileged Tab fields.
- The restricted `https://chatgpt.com/*` host permission provides the required host-scoped access for ChatGPT tab URL inspection.
- `chrome.storage.session` and `chrome.storage.local` require the `"storage"` permission.
- A static content script matched only to `https://chatgpt.com/*` does not require `"scripting"`.
- The MVP has no requirement for network interception, debugger access, arbitrary-host injection, or runtime active-tab elevation.

The MVP must not:

- execute remotely hosted JavaScript,
- evaluate downloaded code,
- expose a general-purpose page-to-extension command channel,
- trust arbitrary page-provided data as control instructions,
- inject into unrelated sites.

Content-script observations from the page are untrusted evidence. Relay authority comes only from the controller's persisted session and causal protocol identifiers.

Chrome 140–144 are explicitly unsupported even though `splitViewId` exists there, because the MVP depends on the native user-facing Split View introduced in Chrome 145.

Automatic Split View creation remains outside the MVP and remains a Chrome 155+ future phase.

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

### 19.1 Relay Controller and protocol unit tests

Use pure state-transition tests with mocked extension I/O and deterministic event ordering.

Cover at minimum:

- valid initial A wait baseline creation and arm before Start succeeds;
- a pre-Start existing assistant response is not accepted as the initial response;
- Start is rejected when A is already generating;
- valid A → B and B → A transitions;
- target completion occurring before transfer commit acknowledgement processing is buffered and later accepted, not lost;
- stale `waitId` completion does not advance a later turn;
- old `sessionId` completion does not advance a later session;
- unexpected-side event rejection;
- duplicate response rejection for the same wait/message;
- two distinct assistant messages with identical text (for example `OK`, then `OK`) are both accepted exactly once;
- `maxTurns` cannot race with creation of a new `PendingTransfer`;
- Stop vs assistant-complete race;
- Stop vs transfer acknowledgement race;
- Stop during dispatch before submit commit;
- Stop during dispatch after submit commit;
- tab-close vs transfer acknowledgement race;
- stale async continuation cannot overwrite `stopping`, `stopped`, or `error`;
- explicit Stop with no in-flight transfer;
- tab closure;
- invalid navigation;
- `splitViewId` becoming `SPLIT_VIEW_ID_NONE`;
- `splitViewId` changing through `tabs.onUpdated`;
- service-worker reconstruction from persisted `revision`, wait, and transfer state.

### 19.2 ChatGPT Adapter and identity tests

DOM fixtures should test ChatGPT-facing behavior without requiring the real site for every case.

Cover at minimum:

- prompt editor discovery;
- generation-state detection;
- assistant-message extraction;
- stream-to-stable completion detection;
- no completion emission without an armed wait;
- baseline excludes an already existing assistant response;
- response completion can be buffered until its armed wait is consumable;
- distinct same-text messages receive distinct `messageId` values;
- accepted message → reload → same visible message reconstructs to the same identity and is not re-emitted;
- unsafe fallback identity reconstruction returns an ambiguity error instead of content-hash guessing;
- refusal to overwrite user input;
- submission preparation and exact commit-point reporting;
- cancellation before commit vs already-committed reporting;
- duplicate transfer command rejection;
- submission failure handling;
- selector fallback behavior.

### 19.3 Browser and manifest integration tests

A small integration layer should verify extension wiring in Chromium.

Cover at minimum:

- the packaged manifest declares `minimum_chrome_version: "145"`;
- the packaged permission set is exactly the design-approved MVP security boundary;
- the content script does not inject on non-`chatgpt.com` origins;
- the controller does not accept non-`chatgpt.com` tabs as pair candidates;
- Split View relationship changes cause fail-closed handling.

Chrome versions below the declared minimum are not supported test targets.

Because the real ChatGPT UI and account state are external and mutable, deterministic automated tests should primarily use controlled fixtures or a test harness.

Manual smoke testing against `chatgpt.com` is still required before release because DOM compatibility cannot be fully proven by fixtures.

## 20. MVP acceptance criteria

The MVP is accepted when all of the following are demonstrated:

1. On Chrome 145+, with two logged-in ChatGPT tabs in one native Split View, Start identifies a valid pair and assigns the active tab as A.
2. Start succeeds only after A readiness, non-generating state, baseline capture, persisted `ExpectedResponse`, and wait arming are confirmed.
3. An assistant response that existed before Start is never relayed as the initial A response.
4. After the user manually submits an initial task to A, only the assistant message after the persisted baseline can satisfy the initial `waitId`.
5. A completed response is accepted only when `sessionId + waitId` and, when applicable, `causedByTransferId` match persisted causal state.
6. A target response that completes before the transfer acknowledgement is processed is not lost.
7. Partial streamed text is never submitted to the peer.
8. Two distinct assistant messages with identical normalized text are both relayable exactly once.
9. Reloading an already accepted visible message does not relay it again; ambiguous identity reconstruction fails closed.
10. Reaching `maxTurns` prevents creation/authorization of the next transfer.
11. Once Stop enters `stopping`, no new transfer is created or authorized.
12. An already-authorized in-flight submission is cancelled before commit when provably possible, otherwise reconciled at most once; it never causes a further peer transfer after Stop.
13. After the popup reports `stopped`, no automatic submission may begin.
14. User text already present in the target editor is never overwritten.
15. Closing, navigating, or removing either paired tab from the persisted Split View stops/fails the session safely.
16. Service-worker suspension does not lose `revision`, `ExpectedResponse`, `PendingTransfer`, or accepted-message state.
17. A stale async continuation cannot overwrite a newer `stopping`, `stopped`, or `error` state.
18. A DOM recognition failure stops the relay instead of guessing.
19. An interrupted dispatch is never blindly resubmitted when prior submission status is ambiguous.
20. The relay controller contains no ChatGPT-specific DOM selectors.
21. The packaged extension requests only `"storage"` plus the `https://chatgpt.com/*` host/content-script scope defined in §17; it does not request `tabs`, `activeTab`, `scripting`, `<all_urls>`, `webRequest`, or `debugger`.
22. `chrome.tabs.createSplit()` remains outside the MVP.

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
