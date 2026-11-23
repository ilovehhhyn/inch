// Stands in for the Anthropic client in tests: records every stream request, replays scripted events, and throws on any request nobody scripted.
import Anthropic from "@anthropic-ai/sdk";

const TICK = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export type StreamScript =
  | Readonly<{ kind: "answer"; chunks: ReadonlyArray<string>; stopReason?: "end_turn" | "refusal" | "max_tokens"; category?: string | null; emptyContent?: boolean }>
  | Readonly<{ kind: "fail"; error: Error; chunksBefore?: ReadonlyArray<string> }>
  | Readonly<{ kind: "hang"; chunksBefore?: ReadonlyArray<string> }>;

export type RecordedRequest = Readonly<{ params: Record<string, unknown>; options: Readonly<{ signal?: AbortSignal | undefined }> }>;

export function textDelta(text: string): unknown {
  return { type: "content_block_delta", index: 1, delta: { type: "text_delta", text } };
}

/** The assistant content the fake's final message holds: a thinking block, then the text. */
export function answerContent(chunks: ReadonlyArray<string>): Array<unknown> {
  return [{ type: "thinking", thinking: "", signature: "sig-1" }, { type: "text", text: chunks.join(""), citations: null }];
}

class FakeStream {
  private readonly script: StreamScript;
  private readonly signal: AbortSignal | undefined;

  constructor(script: StreamScript, signal: AbortSignal | undefined) {
    this.script = script;
    this.signal = signal;
  }

  private throwIfAborted(): void {
    if (this.signal?.aborted === true) throw new Anthropic.APIUserAbortError();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
    const { script } = this;
    const chunks = script.kind === "answer" ? script.chunks : (script.chunksBefore ?? []);
    for (const chunk of chunks) {
      await TICK();
      this.throwIfAborted();
      yield textDelta(chunk);
    }
    if (script.kind === "fail") throw script.error;
    if (script.kind === "hang") {
      await new Promise<never>((_, reject) => {
        this.signal?.addEventListener("abort", () => reject(new Anthropic.APIUserAbortError()));
        this.throwIfAborted();
      });
    }
  }

  async finalMessage(): Promise<unknown> {
    if (this.script.kind !== "answer") throw new Error("the fake has a final message only for an answer script");
    const { chunks, stopReason = "end_turn", category = null, emptyContent = false } = this.script;
    return {
      id: "msg_fake",
      type: "message",
      role: "assistant",
      model: "claude-opus-5-5",
      content: emptyContent ? [] : answerContent(chunks),
      stop_reason: stopReason,
      stop_sequence: null,
      stop_details: stopReason === "refusal" ? { type: "refusal", category, explanation: null } : null,
      usage: { input_tokens: 10, output_tokens: 5 },
    };
  }

  abort(): void {
    // The provider aborts through the request's signal; nothing else to stop in the fake.
  }
}

export class FakeAnthropic {
  readonly requests: Array<RecordedRequest> = [];
  private readonly scripts: Array<StreamScript> = [];

  script(...scripts: ReadonlyArray<StreamScript>): this {
    this.scripts.push(...scripts);
    return this;
  }

  private stream(params: Record<string, unknown>, options?: { signal?: AbortSignal }): FakeStream {
    this.requests.push({ params: structuredClone(params), options: { signal: options?.signal } });
    const script = this.scripts.shift();
    if (script === undefined) throw new Error("FakeAnthropic received a stream request but no stream was scripted; call script(...) first");
    return new FakeStream(script, options?.signal);
  }

  /** The fake as the SDK client type; it implements only `beta.messages.stream`, the one call the provider makes. */
  asClient(): Anthropic {
    return { beta: { messages: { stream: (params: Record<string, unknown>, options?: { signal?: AbortSignal }) => this.stream(params, options) } } } as unknown as Anthropic; // the fake has the one method the provider calls, and a call to any other throws
  }
}
