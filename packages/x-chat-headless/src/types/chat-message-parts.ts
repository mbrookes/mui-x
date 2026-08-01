import type { ChatCustomMessagePartMap, ChatDataPartMap } from './chat-type-registry';
import type {
  ChatDataPartTypePattern,
  ChatKnownDataPartType,
  ChatKnownToolName,
  ChatRegisteredDataPartType,
  ChatToolInput,
  ChatToolOutput,
} from './chat-type-helpers';

export type ChatMessagePartStatus = 'streaming' | 'done';

export interface ChatTextMessagePart {
  type: 'text';
  text: string;
  state?: ChatMessagePartStatus;
}

export interface ChatReasoningMessagePart {
  type: 'reasoning';
  text: string;
  state?: ChatMessagePartStatus;
}

export interface ChatFileMessagePart {
  type: 'file';
  mediaType: string;
  url: string;
  filename?: string;
}

export interface ChatSourceUrlMessagePart {
  type: 'source-url';
  sourceId: string;
  url: string;
  title?: string;
}

export interface ChatSourceDocumentMessagePart {
  type: 'source-document';
  sourceId: string;
  title?: string;
  text?: string;
}

export type ChatDataPartType = ChatDataPartTypePattern;

export interface ChatFallbackDataMessagePart<
  TType extends ChatKnownDataPartType = ChatKnownDataPartType,
> {
  type: TType;
  id?: string;
  data: [ChatRegisteredDataPartType] extends [never]
    ? unknown
    : TType extends keyof ChatDataPartMap
      ? ChatDataPartMap[TType]
      : never;
  transient?: boolean;
}

type ChatRegisteredDataMessagePart = {
  [TType in ChatRegisteredDataPartType]: {
    type: TType;
    id?: string;
    data: ChatDataPartMap[TType];
    transient?: boolean;
  };
}[ChatRegisteredDataPartType];

export type ChatDataMessagePart = [ChatRegisteredDataPartType] extends [never]
  ? ChatFallbackDataMessagePart
  : ChatRegisteredDataMessagePart;

export interface ChatStepStartMessagePart {
  type: 'step-start';
}

export type ChatToolInvocationState =
  | 'input-streaming'
  | 'input-available'
  | 'approval-requested'
  | 'approval-responded'
  | 'output-available'
  | 'output-error'
  | 'output-denied';

export interface ChatToolApproval {
  approved: boolean;
  reason?: string;
}

/**
 * What the backend said when it ASKED for approval, as opposed to `ChatToolApproval`,
 * which is what the human answered.
 *
 * Both halves exist because an approve/deny prompt that shows only the tool name and
 * its raw arguments asks a human to authorize an operation whose impact they cannot
 * see — an id matrix for a layout change, an opaque id list for a bulk delete.
 *
 * `effects` is deliberately `unknown`: the useful summary is domain-specific (which
 * dashboard widgets get deleted, which records get written), and this package has no
 * vocabulary for it. It is carried verbatim from the `tool-approval-request` chunk to
 * the invocation, exposed on `ToolPartOwnerState`, and rendered ONLY by a host-supplied
 * `approvalDetails` slot that knows the shape. Treat it as untrusted: it arrives over
 * the wire, so a renderer must narrow every value it puts in JSX rather than trusting
 * the declared type of whatever it casts this to.
 */
export interface ChatToolApprovalRequestDetails {
  /**
   * Why approval is required, in the backend's own words (a policy's stated reason —
   * "this exceeds today's mutation budget"). A plain string, so `ToolPart` renders it
   * itself, above the approve/deny buttons.
   */
  reason?: string;
  /** Structured, domain-specific summary of what running the tool will do. Opaque here. */
  effects?: unknown;
  /**
   * The arguments AS THE BACKEND WANTS THEM SHOWN on the approval card, kept apart from
   * `ChatToolInvocation.input` because the two answer to different parties.
   *
   * `input` is the model's own arguments: a replay serialiser resends it as what the model
   * said, so a producer that overwrites it with anything else teaches the model a shape its
   * own tool schema rejects. The approval card's arguments are something else — a backend
   * that resolves ids against real state, so a human approves against real titles and a
   * prompt-injected model cannot label a destructive call with a title of its own choosing.
   *
   * With ONE field for both, a producer had to choose, and both choices were wrong. Leaving
   * the enriched copy in `input` made the next request resend a display shape as the model's
   * arguments. Restoring the model's arguments over it at stream end — what `x-studio`'s
   * adapter does on every path where a card is still pending — put the model's OWN chosen
   * labels directly above a live Approve button, with the backend-resolved summary beside
   * them and no cue which was which.
   *
   * So `ToolPart` renders THIS whenever it is present, falling back to `input` when it is not:
   * the field a producer may overwrite for replay fidelity stays overwritable, and the human
   * keeps seeing what the backend verified.
   *
   * In every state, not only while the card is pending. The producer's re-assert fires exactly
   * when the gated call SETTLES, so a pending-only rule handed the card back to the model's own
   * labels the moment the human answered — the card is the record of the decision, and the
   * record has to be of what the human was shown.
   */
  displayInput?: unknown;
}

export interface ChatToolInvocation<TToolName extends ChatKnownToolName = ChatKnownToolName> {
  toolCallId: string;
  toolName: TToolName;
  state: ChatToolInvocationState;
  input?: ChatToolInput<TToolName>;
  output?: ChatToolOutput<TToolName>;
  errorText?: string;
  approval?: ChatToolApproval;
  approvalId?: string;
  /** What the backend said when it asked for approval — see {@link ChatToolApprovalRequestDetails}. */
  approvalRequest?: ChatToolApprovalRequestDetails;
  providerExecuted?: boolean;
  title?: string;
  callProviderMetadata?: Record<string, unknown>;
  preliminary?: boolean;
}

export interface ChatToolMessagePart<TToolName extends ChatKnownToolName = ChatKnownToolName> {
  type: 'tool';
  toolInvocation: ChatToolInvocation<TToolName>;
}

export interface ChatDynamicToolInvocation<TToolName extends string = string> {
  toolCallId: string;
  toolName: TToolName;
  state: ChatToolInvocationState;
  input?: unknown;
  output?: unknown;
  errorText?: string;
  approval?: ChatToolApproval;
  approvalId?: string;
  /** What the backend said when it asked for approval — see {@link ChatToolApprovalRequestDetails}. */
  approvalRequest?: ChatToolApprovalRequestDetails;
  providerExecuted?: boolean;
  title?: string;
  callProviderMetadata?: Record<string, unknown>;
  preliminary?: boolean;
}

export interface ChatDynamicToolMessagePart<TToolName extends string = string> {
  type: 'dynamic-tool';
  toolInvocation: ChatDynamicToolInvocation<TToolName>;
}

export type ChatBuiltInMessagePart =
  | ChatTextMessagePart
  | ChatReasoningMessagePart
  | ChatFileMessagePart
  | ChatSourceUrlMessagePart
  | ChatSourceDocumentMessagePart
  | ChatDataMessagePart
  | ChatStepStartMessagePart
  | ChatToolMessagePart
  | ChatDynamicToolMessagePart;

export type ChatCustomMessagePart = ChatCustomMessagePartMap[keyof ChatCustomMessagePartMap];

export type ChatMessagePart = ChatBuiltInMessagePart | ChatCustomMessagePart;
