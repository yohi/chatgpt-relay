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

The user's initial submission to A is the only manual transcript submission permitted while a relay session is active. After that initial A user turn is observed, any unexpected manual user submission, regenerate, edit, branch, or other transcript-changing operation during the active relay causes fail-closed termination rather than arbitration with the relay protocol.

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

type TranscriptMessageIdentity = {
  messageId: string;
  role: "user" | "assistant";
  textHash: string;
};

type AssistantResponse = {
  messageId: string;
  text: string;
  textHash: string;
};

type AdapterSnapshot = {
  ready: boolean;
  generating: boolean;
  conversationIdentity: string | null;
  latestUser: TranscriptMessageIdentity | null;
  latestAssistant: AssistantResponse | null;
};

type PreparedSubmission = {
  transferId: string;
  waitId: string;
  baselineMessageId: string | null;
  conversationIdentity: string | null;
};

type CommittedSubmission = {
  transferId: string;
  waitId: string;
  userMessageId: string;
  conversationIdentity: string;
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
  }): Promise<CommittedSubmission>;

  bindExpectedUserTurn(input: {
    sessionId: string;
    waitId: string;
    userMessageId: string;
    conversationIdentity: string;
    authorizationRevision: number;
  }): Promise<void>;

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
- Reconstructing the current stable conversation identity when available.
- Extracting stable user- and assistant-message transcript identities according to §9.
- Capturing a response baseline before a wait is armed.
- Installing completion observation before an automated target submission can begin.
- Staging relay text without overwriting unexpected user input.
- Triggering a normal UI submission.
- Identifying the exact newly-created user transcript message produced by that submission.
- Binding that user-message identity to the active transfer/wait before its assistant response may be emitted.
- Buffering a completed response for an armed `waitId` until the controller has persisted the causal user-turn binding and is ready to receive it.
- Defining and reporting the submission commit point.
- Detecting stable generation completion.
- Detecting unexpected manual user turns, regenerate/edit/branch operations, or other transcript ancestry changes while a relay-owned response is expected.
- Rejecting stale, duplicate, or mismatched session/transfer/wait commands.

All selectors and ChatGPT-specific heuristics must remain inside this layer so DOM changes do not leak into relay orchestration.

The adapter must never emit an `assistant-complete` event merely because a completed assistant node exists or because a known `causedByTransferId` can be copied into the event. For an automated wait, the observed assistant turn must be proven to belong to the exact relay-created user transcript turn persisted in that `ExpectedResponse`.

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
  causedByUserMessageId?: string;
};
```

Every accepted completion is bound to exactly one `sessionId + waitId`.

For an automated transfer, `causedByTransferId` is only the relay-protocol transfer label. It is not sufficient causal evidence by itself. Before any automated assistant completion can be accepted, the active `ExpectedResponse` must also contain the exact transcript identity of the relay-created user message in `causedByUserMessageId`.

An `assistant-complete` event is valid only when:

1. its `sessionId` equals the currently persisted relay session;
2. its `waitId` equals the currently persisted `ExpectedResponse.waitId`;
3. its sender tab and side match the persisted expected tab and side;
4. its message is strictly after the persisted response baseline;
5. for an automated target response, both `causedByTransferId` and `causedByUserMessageId` match the persisted transfer and user-turn causal anchors;
6. transcript ancestry proves that the assistant response belongs to the exact causal user turn defined below;
7. the message has not already been accepted for that wait.

A stale or unknown `waitId`, an old `sessionId`, a copied/echoed `causedByTransferId` without matching transcript ancestry, or a mismatched user-turn binding must not advance the state machine.

### 8.1 Initial A ordering

Start has the following normative ordering:

```text
1. receive Start request
2. validate the Split View pair and assign active tab = A
3. confirm both adapters are ready and inspect both conversation identities
4. initialize/persist side conversation bindings according to §9.1
5. confirm A is not currently generating; otherwise reject Start
6. inspect A and capture the latest assistant message identity as baseline
7. generate sessionId and waitId
8. persist RelaySession + ExpectedResponse(A, waitId, baseline)
9. arm A adapter with that exact ExpectedResponse
10. confirm the arm succeeded
11. report Start success to the popup/user
12. user manually submits the initial task to A
13. the first allowed post-Start A user turn becomes the initial causal user turn
14. if A was unbound, bind its first stable conversation identity only when that identity is causally associated with this allowed initial user turn
15. only the assistant response belonging to that initial user turn and strictly after baseline may complete waitId
```

An assistant response that existed before Start can therefore never satisfy the initial wait.

Exactly one manual initial A user turn is permitted. A second manual user turn, regenerate/edit/branch operation, or ambiguous transcript mutation before the expected assistant response is resolved fails closed.

### 8.2 Automated target ordering

For A → B or B → A, completion observation must exist before the UI submission can produce a target response, and the response must be anchored to the exact relay-created user transcript turn.

The normative protocol is:

```text
controller:
  accept source completion for current ExpectedResponse
  persist PendingTransfer and dispatching-target state
  ↓
target adapter prepareSubmission:
  validate editor/generation safety
  reconstruct current conversation identity
  capture target latest-assistant baseline
  install/bind completion observation for target waitId
  stage the relay text without submitting it
  return PreparedSubmission including current conversation identity
  ↓
controller:
  re-read and revalidate persisted session
  verify target conversation binding according to §9.1
  persist target ExpectedResponse(waitId, baseline, causedByTransferId)
  persist dispatch authorization revision
  ↓
target adapter commitSubmission:
  revalidate session/transfer/wait identifiers
  revalidate current conversation against the authorized binding
  cross the defined submission commit point
  trigger normal ChatGPT UI submission
  identify the exact newly-created user transcript message for this relay submission
  obtain/reconstruct its stable userMessageId
  obtain/reconstruct the resulting stable conversation identity
  return CommittedSubmission(userMessageId, conversationIdentity)
  assistant completion may occur meanwhile but remains buffered by waitId
  ↓
controller:
  re-read and revalidate persisted session
  verify/adopt the side conversation binding according to §9.1
  persist causedByUserMessageId on the same ExpectedResponse
  persist turn increment and waiting-target state
  increment revision
  ↓
target adapter bindExpectedUserTurn:
  bind the persisted userMessageId + conversationIdentity to waitId
  verify transcript ancestry
  if expected assistant already completed, emit it now
  otherwise emit it when completion conditions become true
```

No implementation may accept an automated completion before the exact relay-created user message has been identified and persisted as the causal anchor.

No implementation may use an ordering in which a valid target completion can be discarded solely because it completed before the submission acknowledgement or user-turn binding was processed.

If the adapter cannot prove which newly-created user transcript message corresponds to the relay submission, or cannot safely derive its identity, the session enters `relay-causality-ambiguous` error.

### 8.3 Transcript causal ancestry

For the MVP, an assistant response belongs to an expected relay user turn only when the adapter can establish all of the following from the current transcript:

1. the persisted `causedByUserMessageId` identifies the exact expected user message;
2. the candidate assistant message occurs in the same persisted conversation binding;
3. the candidate assistant is the assistant turn causally following that user message in the active transcript branch;
4. no other user message was inserted between the expected user message and candidate assistant;
5. no unexpected regenerate, edit, branch, or equivalent transcript-rewriting operation invalidated that ancestry.

If the DOM does not provide an explicit parent/turn relationship, stable transcript ordering may be used only when it proves the same invariants unambiguously.

A candidate assistant event that merely carries the correct `sessionId`, `waitId`, or `causedByTransferId` but is not causally after the persisted relay-created user message is rejected.

### 8.4 Active-relay manual interaction policy

The only permitted manual transcript submission during an active relay session is the initial A prompt described in §8.1.

After that initial user turn:

- an unexpected manual user submission;
- regenerate;
- edit;
- branch/conversation-fork action;
- or another transcript mutation that changes expected turn ancestry

causes fail-closed termination.

The MVP does not arbitrate or merge manual turns with relay-owned turns.

### 8.5 Completion evidence

For the armed response, the adapter considers generation complete only after all required conditions hold:

1. an assistant response strictly after the armed baseline exists;
2. the response is no longer visibly changing;
3. ChatGPT is no longer in its active generation state;
4. the response content remains stable for a debounce interval;
5. the response identity satisfies §9;
6. transcript causal ancestry satisfies §8.3;
7. the response has not already been emitted for that `waitId`.

A `MutationObserver` may be used as a change signal, but a DOM mutation alone is never completion evidence.

The implementation should prefer multiple independent completion signals over a single fragile selector.

## 9. Transcript message identity and conversation binding

Message identity is distinct from content identity. Two different transcript turns are allowed to contain exactly the same text and must still have distinct identities.

The conceptual identity shapes are:

```ts
type TranscriptMessageIdentity = {
  messageId: string;
  role: "user" | "assistant";
  textHash: string;
};

type AssistantResponse = {
  messageId: string;
  text: string;
  textHash: string;
};

type ConversationBinding =
  | { state: "unbound" }
  | { state: "bound"; conversationIdentity: string };
```

`textHash` is a deterministic hash of normalized relay text. It is evidence about content, not by itself a persistent message identity.

### 9.1 Conversation binding

The RelaySession owns one persisted conversation binding for each side.

At Start:

- if an adapter can reconstruct a stable conversation identity for a side, that side is immediately persisted as `bound(conversationIdentity)`;
- only a genuinely new/unidentified ChatGPT conversation may start as `unbound`.

An `unbound` side may transition to `bound` exactly once, and only when the adapter can causally associate the newly appeared stable conversation identity with that side's first allowed prompt submission:

- the manual initial A user turn; or
- the first relay-owned automated submission to that side.

A stable identity that appears because the user manually navigated to another conversation is not adoptable.

Once a side is `bound`, its `conversationIdentity` is immutable for the lifetime of that relay session.

For every state-mutating observation, wait arm, submission preparation, submission commit, completion acceptance, and reload/resynchronization, the controller compares the adapter's current conversation identity with the persisted side binding.

The required behavior is:

```text
bound(X) + current X
  → valid

bound(X) + current Y
  → conversation-changed error

bound(X) + current null/unknown
  → error if identity is required to prove the operation safely

unbound + no stable identity
  → remain unbound only until the first allowed prompt can establish identity

unbound + stable identity causally produced by the first allowed prompt
  → persist bound(identity) exactly once

unbound + stable identity from unrelated navigation/manual replacement
  → conversation-changed error
```

The controller must revalidate the target conversation binding both before `prepareSubmission()` authorization and again before `commitSubmission()` may cross the submission commit point.

A same-tab, same-origin, same-Split-View navigation from ChatGPT conversation X to conversation Y never causes automatic adoption of Y.

### 9.2 User and assistant message identity precedence

For both user and assistant transcript messages, the adapter uses this identity precedence:

1. **Verified stable DOM identity.** If ChatGPT exposes a per-message identifier that the adapter can verify as stable for the same transcript message across a normal re-read/reload, `messageId` uses that identifier.
2. **Deterministic transcript fallback.** If no verified stable DOM identifier exists, `messageId` is derived from:
   - the persisted stable conversation identity,
   - the stable role-specific message ordinal in the reconstructed transcript,
   - normalized content hash.
3. **Ambiguous reconstruction.** If reload or DOM state does not allow the conversation identity and transcript ordinal to be reconstructed safely, the adapter must not fall back to content hash alone. Recovery stops with `message-identity-ambiguous`.

`tabId + contentHash`, content hash alone, or another content-only key must never be used as persistent message identity.

The role-specific ordinal counts transcript messages of that role in stable transcript order, not unique content values. Therefore two separate assistant messages containing `OK`, or two separate user messages containing the same relay text, still have different identities.

The Relay Controller records the accepted assistant message identity associated with each consumed `ExpectedResponse`, plus the causal user-message identity for automated waits.

After reload, an already accepted visible message must reconstruct to the same `messageId`; if that cannot be proven, the relay fails closed instead of guessing.

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
  targetUserMessageId?: string;
  authorizationRevision?: number;
  submissionState: "preparing" | "authorized" | "committed";
};

type RelaySession = {
  id: string;
  revision: number;
  splitViewId: number;
  tabA: number;
  tabB: number;
  conversationA: ConversationBinding;
  conversationB: ConversationBinding;
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

1. verifies the source conversation binding and expected user-turn ancestry;
2. verifies that creating another transfer would not exceed `maxTurns`;
3. creates and persists `PendingTransfer`;
4. moves to the corresponding `dispatching-*` state;
5. increments `revision`;
6. revalidates the target conversation binding;
7. only then instructs the target adapter to prepare/submit according to §8.2.

Before the submission commit point, the controller revalidates the target conversation binding again. A changed, replaced, or ambiguously unidentified bound conversation cannot receive the relay submission.

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
      causedByUserMessageId?: string;
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
      conversationIdentity: string | null;
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
      userMessageId: string;
      conversationIdentity: string;
    }
  | {
      type: "bind-expected-user-turn";
      sessionId: string;
      waitId: string;
      userMessageId: string;
      conversationIdentity: string;
      authorizationRevision: number;
    }
  | {
      type: "transcript-interference";
      sessionId: string;
      waitId: string;
      reason: "unexpected-user-turn" | "regenerate" | "edit" | "branch" | "causality-ambiguous";
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

Before accepting an adapter event, the controller revalidates the latest persisted `sessionId`, `revision`, `waitId`, `transferId`, causal user-message identity, and side conversation binding required by that event.

The content script must reject commands that do not belong to its intended tab/session or that replay an already-consumed transfer/wait authorization.

For an automated wait, an `assistant-complete` message without the currently persisted `sessionId + waitId + causedByUserMessageId` and matching transcript ancestry is never a relay completion, even if it carries the correct `causedByTransferId`.

## 14. User-input and transcript-interference protection

The extension must not silently overwrite user-composed text.

Before submitting a relayed response, the adapter must confirm that the prompt editor is in a safe state.

If unexpected user text is already present, the relay stops with an actionable error rather than replacing or appending to it automatically.

The extension must also refuse to submit while the target ChatGPT tab is already generating a response.

The manual initial A prompt defined in §8.1 is explicitly allowed. After that prompt, the active relay owns the expected transcript turns until the session stops.

If either adapter detects an unexpected manual user submission, regenerate, edit, branch, or another transcript mutation that can change causal ancestry, it emits transcript-interference evidence and the controller fails closed. The MVP does not attempt to merge, queue, or arbitrate manual user activity with relay activity.

## 15. Failure handling

The relay stops safely when any of the following occurs:

- One paired tab is closed.
- One paired tab navigates away from an allowed ChatGPT origin.
- Either paired tab loses or changes the persisted Split View relationship.
- A bound side's current ChatGPT conversation identity differs from its persisted binding.
- A bound side's conversation identity becomes unavailable when identity is required to prove a wait, submission, or recovery safely.
- An unbound side presents a stable conversation identity that cannot be causally attributed to its first allowed prompt.
- The prompt editor cannot be identified.
- The adapter cannot determine generation state safely.
- A Start request finds A already generating.
- The target prompt contains unexpected user text.
- Submission cannot be prepared or committed safely.
- The exact relay-created user transcript message cannot be identified after commit.
- The expected assistant's causal ancestry to the persisted user turn cannot be proven.
- An unexpected manual user turn, regenerate, edit, branch, or equivalent transcript mutation occurs after the allowed initial A prompt.
- A stale or invalid session/revision/wait/transfer command is received where recovery cannot safely ignore it.
- The active response cannot be identified reliably.
- Message identity cannot be reconstructed safely after reload.
- An interrupted transfer cannot be proven committed or cancelled.
- `maxTurns` is reached.
- The user presses Stop.

The controller records a machine-readable stop/error reason and exposes a user-readable explanation through the popup. Relevant protocol reasons include `relay-causality-ambiguous`, `conversation-changed`, and `message-identity-ambiguous`.

No automatic retry may create a duplicate user-visible ChatGPT message.

Submission commands are identified by `transferId`. A target adapter must reject a duplicate command it can prove it has already applied. If it cannot prove whether a prior interrupted command was applied, it must not guess; the controller reconciles visible page state or enters `error`.

A transition to `error`, `stopping`, or `stopped` is monotonic for that session: a stale async continuation may not restore a waiting or dispatching state.

## 16. Reload and resynchronization

A ChatGPT tab reload must not automatically resume by replaying the last peer message.

After reload:

1. The content script announces readiness.
2. The controller enters the serialized transition path and loads the latest persisted session.
3. The controller verifies that the tab still belongs to the persisted active pair.
4. The adapter reconstructs current conversation identity, transcript user/assistant message identities, latest assistant identity, current generation state, and any evidence relevant to a persisted `ExpectedResponse` or `PendingTransfer`.
5. The controller compares the reconstructed conversation identity with that side's persisted `ConversationBinding`.
6. For `bound(X)`, only current identity X may resume; Y, null, or ambiguous identity causes `conversation-changed`/fail-closed handling when safe identity cannot be proven.
7. An `unbound` binding may be adopted only under the one-time causal adoption rule in §9.1; reload alone is never authority to adopt an arbitrary conversation.
8. An already accepted visible message must reconstruct to the same `messageId`; it is not emitted again.
9. If a persisted wait exists, the adapter may re-arm only that same `sessionId + waitId` against its persisted baseline and causal user-message identity; it must not synthesize a new wait around the latest DOM response.
10. If an automated wait already has `causedByUserMessageId`, the adapter must reconstruct that exact user transcript turn and prove the candidate assistant ancestry from it.
11. A dispatch interrupted after visible submission but before acknowledgement is reconciled as submitted only when target-page evidence includes the same conversation binding and relay-created user-message identity unambiguously.
12. Relay resumes only if conversation binding, message identity, wait identity, user-turn causality, transfer state, and Split View pairing can all be reconciled without ambiguity.

If transcript ordering/ordinal cannot be reconstructed safely, if the same message cannot be identified across reload, if conversation identity differs from a persisted binding, if causal user-turn ancestry cannot be proven, or if transfer commit status is ambiguous, the session transitions to `error`.

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
- the initial A manual prompt remains permitted and is the only manual user turn allowed by the active relay;
- valid A → B and B → A transitions;
- relay-created target user message → causally following assistant = accepted;
- relay-created target user message → unexpected manual user message → assistant = error, not relay completion;
- unexpected regenerate/edit/branch evidence during an expected relay turn fails closed when causal ancestry cannot be proven;
- an `assistant-complete` event that merely echoes the correct `causedByTransferId` but is not causally after the persisted relay user message is rejected;
- target completion occurring before transfer commit acknowledgement/user-turn binding processing is buffered and later accepted, not lost;
- stale `waitId` completion does not advance a later turn;
- old `sessionId` completion does not advance a later session;
- unexpected-side event rejection;
- duplicate response rejection for the same wait/message;
- two distinct assistant messages with identical text (for example `OK`, then `OK`) are both accepted exactly once;
- a stable bound conversation remains unchanged and relay continues;
- same tab + same `chatgpt.com` origin + different conversation identity causes error;
- target conversation change between waits prohibits prepare/commit;
- new-chat `unbound → bound` occurs once only when causally associated with the first allowed prompt;
- later conversation identity change after binding is rejected;
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
- service-worker reconstruction from persisted `revision`, wait, transfer, conversation, and causal-user-turn state.

### 19.2 ChatGPT Adapter and identity tests

DOM fixtures should test ChatGPT-facing behavior without requiring the real site for every case.

Cover at minimum:

- prompt editor discovery;
- generation-state detection;
- user- and assistant-message extraction;
- stream-to-stable completion detection;
- no completion emission without an armed wait;
- baseline excludes an already existing assistant response;
- exact relay-created user transcript message is identified after submission;
- response completion can be buffered until its causal user-turn binding is persisted/armed;
- unexpected intervening user turn invalidates the expected assistant ancestry;
- regenerate/edit/branch evidence invalidates ancestry when a unique causal path cannot be proven;
- distinct same-text messages receive distinct `messageId` values;
- accepted message → reload → same visible message reconstructs to the same identity and is not re-emitted;
- unsafe fallback identity reconstruction returns an ambiguity error instead of content-hash guessing;
- same conversation identity survives reload and can resume;
- different conversation identity after reload fails closed;
- new-chat identity can be adopted once after the first allowed prompt and not replaced later;
- refusal to overwrite user input;
- submission preparation and exact commit-point reporting;
- target conversation binding is checked during preparation and again before commit;
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
2. Start persists A/B conversation bindings when stable identities exist and allows `unbound` only for a genuinely unidentified new conversation.
3. Start succeeds only after A readiness, non-generating state, baseline capture, persisted `ExpectedResponse`, and wait arming are confirmed.
4. An assistant response that existed before Start is never relayed as the initial A response.
5. The user's first post-Start A user turn is permitted as the initial prompt; later unexpected manual transcript intervention fails closed.
6. For automated transfers, a completion is accepted only after the exact relay-created user transcript message has been identified and persisted in `causedByUserMessageId`.
7. Correct `sessionId + waitId + causedByTransferId` without matching causal user-turn ancestry is insufficient and is rejected.
8. A target response that completes before transfer acknowledgement/user-turn binding processing is not lost.
9. An unexpected manual user turn, regenerate, edit, branch, or ambiguous ancestry between relay prompt and expected assistant produces error rather than relay completion.
10. Partial streamed text is never submitted to the peer.
11. Two distinct assistant messages with identical normalized text are both relayable exactly once.
12. Reloading an already accepted visible message does not relay it again; ambiguous identity reconstruction fails closed.
13. Once a side is `bound(X)`, same-tab navigation to conversation Y or loss of provable identity cannot be automatically adopted and causes error.
14. An `unbound` new-chat side may adopt one stable conversation identity only when causally associated with its first allowed prompt; the binding is immutable afterward.
15. Target conversation binding is revalidated before submission preparation and again before the submission commit point.
16. Reload/resynchronization resumes only when reconstructed conversation identity matches the persisted side binding and causal user-turn ancestry is preserved.
17. Reaching `maxTurns` prevents creation/authorization of the next transfer.
18. Once Stop enters `stopping`, no new transfer is created or authorized.
19. An already-authorized in-flight submission is cancelled before commit when provably possible, otherwise reconciled at most once; it never causes a further peer transfer after Stop.
20. After the popup reports `stopped`, no automatic submission may begin.
21. User text already present in the target editor is never overwritten.
22. Closing, navigating away from the allowed origin, changing conversation identity, or removing either paired tab from the persisted Split View stops/fails the session safely.
23. Service-worker suspension does not lose `revision`, conversation bindings, `ExpectedResponse`, causal user-message identity, `PendingTransfer`, or accepted-message state.
24. A stale async continuation cannot overwrite a newer `stopping`, `stopped`, or `error` state.
25. A DOM recognition failure stops the relay instead of guessing.
26. An interrupted dispatch is never blindly resubmitted when prior submission status is ambiguous.
27. The relay controller contains no ChatGPT-specific DOM selectors.
28. The packaged extension requests only `"storage"` plus the `https://chatgpt.com/*` host/content-script scope defined in §17; it does not request `tabs`, `activeTab`, `scripting`, `<all_urls>`, `webRequest`, or `debugger`.
29. `chrome.tabs.createSplit()` remains outside the MVP.

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
