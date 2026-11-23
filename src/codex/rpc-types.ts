// Types shared by the JSON-RPC connection: request parameters, request results and callbacks.
import type { ClientRequest } from "./generated/ClientRequest";
import type { InitializeResponse } from "./generated/InitializeResponse";
import type { JsonValue } from "./generated/serde_json/JsonValue";
import type { CancelLoginAccountResponse } from "./generated/v2/CancelLoginAccountResponse";
import type { GetAccountResponse } from "./generated/v2/GetAccountResponse";
import type { LoginAccountResponse } from "./generated/v2/LoginAccountResponse";
import type { LogoutAccountResponse } from "./generated/v2/LogoutAccountResponse";
import type { ModelListResponse } from "./generated/v2/ModelListResponse";
import type { ThreadForkResponse } from "./generated/v2/ThreadForkResponse";
import type { ThreadListResponse } from "./generated/v2/ThreadListResponse";
import type { ThreadReadResponse } from "./generated/v2/ThreadReadResponse";
import type { ThreadResumeResponse } from "./generated/v2/ThreadResumeResponse";
import type { ThreadStartResponse } from "./generated/v2/ThreadStartResponse";
import type { TurnInterruptResponse } from "./generated/v2/TurnInterruptResponse";
import type { TurnStartResponse } from "./generated/v2/TurnStartResponse";

export type { JsonValue };

export type Unsubscribe = () => void;

/** Result type of every client request Margin sends; the generated bindings do not map methods to results. */
export type RequestResults = Readonly<{
  initialize: InitializeResponse;
  "account/read": GetAccountResponse;
  "account/login/start": LoginAccountResponse;
  "account/login/cancel": CancelLoginAccountResponse;
  "account/logout": LogoutAccountResponse;
  "model/list": ModelListResponse;
  "thread/start": ThreadStartResponse;
  "thread/resume": ThreadResumeResponse;
  "thread/fork": ThreadForkResponse;
  "thread/list": ThreadListResponse;
  "thread/read": ThreadReadResponse;
  "turn/start": TurnStartResponse;
  "turn/interrupt": TurnInterruptResponse;
}>;

export type RequestMethod = keyof RequestResults & ClientRequest["method"];

export type ParamsOf<Method extends RequestMethod> = Extract<ClientRequest, { method: Method }>["params"];

export type ResultOf<Method extends RequestMethod> = RequestResults[Method];
