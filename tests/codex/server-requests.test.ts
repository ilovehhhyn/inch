// Invariant: Margin never approves anything the app-server asks for, and every decline is logged with method and thread.
import { expect, test } from "vitest";

import type { ServerRequest } from "../../src/codex/generated/ServerRequest";
import { answerServerRequest } from "../../src/codex/server-requests";

const THREAD = "thread-1";

/** Fixtures carry only the fields the handler reads; the cast records that the other generated fields are omitted. */
function serverRequest(method: ServerRequest["method"], id: number, params: Record<string, unknown>): ServerRequest {
  return { method, id, params } as unknown as ServerRequest;
}

const APPROVALS: ReadonlyArray<Readonly<{ request: ServerRequest; expected: unknown }>> = [
  {
    request: serverRequest("item/commandExecution/requestApproval", 1, { threadId: THREAD, turnId: "t", itemId: "i" }),
    expected: { decision: "decline" },
  },
  {
    request: serverRequest("item/fileChange/requestApproval", 2, { threadId: THREAD, turnId: "t", itemId: "i" }),
    expected: { decision: "decline" },
  },
  {
    request: serverRequest("applyPatchApproval", 3, { conversationId: THREAD, callId: "c", fileChanges: {}, reason: null, grantRoot: null }),
    expected: { decision: { denied: { rejection: "Margin never edits files" } } },
  },
  {
    request: serverRequest("execCommandApproval", 4, { conversationId: THREAD, callId: "c", approvalId: null, command: ["ls"], cwd: "/tmp", reason: null, parsedCmd: [] }),
    expected: { decision: { denied: { rejection: "Margin never runs commands" } } },
  },
  {
    request: serverRequest("item/permissions/requestApproval", 5, { threadId: THREAD, turnId: "t", itemId: "i", cwd: "/tmp", reason: null, permissions: {} }),
    expected: { permissions: {}, scope: "turn" },
  },
];

test("every_approval_request_is_declined", () => {
  for (const { request, expected } of APPROVALS) {
    const logLines: Array<string> = [];

    const answer = answerServerRequest(request, (line) => void logLines.push(line));

    expect(answer, request.method).toEqual(expected);
    expect(logLines, request.method).toHaveLength(1);
    expect(logLines[0], request.method).toContain(request.method);
    expect(logLines[0], request.method).toContain(THREAD);
  }
});

test("a_user_input_request_gets_an_empty_answer_and_is_logged", () => {
  const logLines: Array<string> = [];

  const answer = answerServerRequest(serverRequest("item/tool/requestUserInput", 6, { threadId: THREAD, turnId: "t", itemId: "i", questions: [] }), (line) => void logLines.push(line));

  expect(answer).toEqual({ answers: {} });
  expect(logLines).toHaveLength(1);
  expect(logLines[0]).toContain("item/tool/requestUserInput");
  expect(logLines[0]).toContain(THREAD);
});

test("an_mcp_elicitation_is_declined", () => {
  const answer = answerServerRequest(serverRequest("mcpServer/elicitation/request", 7, { threadId: THREAD }), () => undefined);

  expect(answer).toEqual({ action: "decline", content: null, _meta: null });
});

test("a_request_margin_cannot_answer_is_an_error_naming_the_method", () => {
  const request: ServerRequest = { method: "account/chatgptAuthTokens/refresh", id: 8, params: { reason: "unauthorized", previousAccountId: null } };

  expect(() => answerServerRequest(request, () => undefined)).toThrow(/Margin cannot answer `account\/chatgptAuthTokens\/refresh`/);
});
