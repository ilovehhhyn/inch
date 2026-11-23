// Answers the app-server's requests to the client by declining every approval, because Margin never runs commands or edits files.
import type { Logger } from "../shared/log";
import type { ApplyPatchApprovalResponse } from "./generated/ApplyPatchApprovalResponse";
import type { ExecCommandApprovalResponse } from "./generated/ExecCommandApprovalResponse";
import type { ServerRequest } from "./generated/ServerRequest";
import type { JsonValue } from "./generated/serde_json/JsonValue";
import type { CommandExecutionRequestApprovalResponse } from "./generated/v2/CommandExecutionRequestApprovalResponse";
import type { FileChangeRequestApprovalResponse } from "./generated/v2/FileChangeRequestApprovalResponse";
import type { McpServerElicitationRequestResponse } from "./generated/v2/McpServerElicitationRequestResponse";
import type { PermissionsRequestApprovalResponse } from "./generated/v2/PermissionsRequestApprovalResponse";
import type { ToolRequestUserInputResponse } from "./generated/v2/ToolRequestUserInputResponse";

const COMMAND_DECLINE: CommandExecutionRequestApprovalResponse = { decision: "decline" };
const FILE_DECLINE: FileChangeRequestApprovalResponse = { decision: "decline" };
const PATCH_DECLINE: ApplyPatchApprovalResponse = { decision: { denied: { rejection: "Margin never edits files" } } };
const EXEC_DECLINE: ExecCommandApprovalResponse = { decision: { denied: { rejection: "Margin never runs commands" } } };
/** An empty permission profile grants nothing. */
const PERMISSIONS_DECLINE: PermissionsRequestApprovalResponse = { permissions: {}, scope: "turn" };
const NO_ANSWER: ToolRequestUserInputResponse = { answers: {} };
const ELICITATION_DECLINE: McpServerElicitationRequestResponse = { action: "decline", content: null, _meta: null };

function threadIdOf(request: ServerRequest): string {
  const params: Readonly<Record<string, unknown>> = request.params;
  const id = params["threadId"] ?? params["conversationId"];
  return typeof id === "string" ? id : "none";
}

/** Returns the reply to one server request and logs each refusal; throws for a method Margin has no answer for. */
export function answerServerRequest(request: ServerRequest, log: Logger): JsonValue {
  const declined = (reply: JsonValue): JsonValue => {
    log(`declined ${request.method} thread=${threadIdOf(request)}`);
    return reply;
  };
  switch (request.method) {
    case "item/commandExecution/requestApproval":
      return declined(COMMAND_DECLINE);
    case "item/fileChange/requestApproval":
      return declined(FILE_DECLINE);
    case "applyPatchApproval":
      return declined(PATCH_DECLINE);
    case "execCommandApproval":
      return declined(EXEC_DECLINE);
    case "item/permissions/requestApproval":
      return declined(PERMISSIONS_DECLINE);
    case "item/tool/requestUserInput":
      return declined(NO_ANSWER);
    case "mcpServer/elicitation/request":
      return declined(ELICITATION_DECLINE);
    case "item/tool/call":
    case "account/chatgptAuthTokens/refresh":
    case "attestation/generate":
    case "currentTime/read":
      throw new Error(`Margin cannot answer \`${request.method}\`; Margin registers no tools, holds no ChatGPT tokens and sends no attestation`);
    default:
      return assertNever(request);
  }
}

function assertNever(request: never): never {
  throw new Error(`unhandled server request ${JSON.stringify(request)}; regenerate bindings and add a case`);
}
