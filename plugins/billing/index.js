import { z } from "zod";

const buckets = z.object({
  uncachedInputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative()
}).strict();
const sample = buckets.extend({ provider: z.string(), model: z.string(), time: z.number() }).strict();
const schema = z.array(sample);

const fromUsage = (usage) => ({
  uncachedInputTokens: usage.inputTokens,
  cacheReadTokens: usage.cacheReadTokens ?? 0,
  cacheWriteTokens: usage.cacheWriteTokens ?? 0,
  outputTokens: usage.outputTokens
});

const definition = {
  key: "billingUsage",
  schema,
  init: () => ({ context: null, samples: [], last: null }),
  apply: (state, event) => {
    // A retry can reuse the same turn/step. Resetting `last` here keeps usage
    // from separate provider requests additive, while streaming usage updates
    // within one request still replace their previous cumulative snapshot.
    if (event.type === "request/context") return { ...state, context: event.data, last: null };
    let turn;
    let step;
    let usage;
    if (event.type === "assistant/chunk" && event.data.chunk.type === "usage") {
      ({ turn, step } = event.data);
      usage = event.data.chunk.usage;
    } else if (event.type === "assistant/message" && event.data.usage !== undefined) {
      ({ turn, step, usage } = event.data);
    } else return state;
    if (!state.context) return state;
    const next = { provider: state.context.provider, model: state.context.model, time: event.time, ...fromUsage(usage) };
    const replacing = state.last && state.last.turn === turn && state.last.step === step;
    const samples = replacing ? [...state.samples.slice(0, -1), next] : [...state.samples, next];
    return { ...state, samples, last: { turn, step } };
  },
  view: (state) => state.samples,
  stateVersion: 2
};

export const name = "desktop-billing";
export const inject = ["sessionProjections"];
export function apply(ctx) { ctx.sessionProjections.register(definition); }
