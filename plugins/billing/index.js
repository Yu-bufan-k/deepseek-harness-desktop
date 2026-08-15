import { z } from "zod";

const buckets = z.object({
  uncachedInputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative()
}).strict();
const sample = buckets.extend({ provider: z.string(), model: z.string(), time: z.number() }).strict();
const schema = z.object({ revision: z.string(), samples: z.array(sample) }).strict();

const fromUsage = (usage) => ({
  uncachedInputTokens: usage.inputTokens,
  cacheReadTokens: usage.cacheReadTokens ?? 0,
  cacheWriteTokens: usage.cacheWriteTokens ?? 0,
  outputTokens: usage.outputTokens
});

const definition = {
  key: "billingUsage",
  schema,
  init: () => ({ context: null, samples: [], last: null, revision: 0 }),
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
    return { ...state, samples, last: { turn, step }, revision: state.revision + 1 };
  },
  view: (state) => ({ revision: String(state.revision), samples: state.samples }),
  stateVersion: 3
};

export const name = "desktop-billing";
export const inject = ["sessionProjections"];
export function apply(ctx) { ctx.sessionProjections.register(definition); }
