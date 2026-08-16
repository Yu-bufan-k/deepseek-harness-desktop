import { z } from "zod";

const buckets = z
  .object({
    uncachedInputTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative(),
    cacheWriteTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
  })
  .strict();
const sample = buckets
  .extend({ provider: z.string(), model: z.string(), time: z.number() })
  .strict();
const toolsRecord = z.record(z.string(), z.number().int().nonnegative());
const schema = z
  .object({
    revision: z.string(),
    samples: z.array(sample),
    tools: z
      .object({ tools: toolsRecord, mcp: toolsRecord, skills: toolsRecord })
      .strict(),
  })
  .strict();

const fromUsage = (usage) => ({
  uncachedInputTokens: usage.inputTokens,
  cacheReadTokens: usage.cacheReadTokens ?? 0,
  cacheWriteTokens: usage.cacheWriteTokens ?? 0,
  outputTokens: usage.outputTokens,
});

const increment = (record, key) => {
  const next = { ...record };
  next[key] = (next[key] ?? 0) + 1;
  return next;
};

const parseSkillName = (argumentsValue) => {
  if (!argumentsValue) return "skill";
  if (typeof argumentsValue === "string") {
    try {
      const parsed = JSON.parse(argumentsValue);
      if (parsed && typeof parsed.name === "string" && parsed.name)
        return parsed.name;
    } catch {
      // 非 JSON 参数串，退回通用名
    }
    return "skill";
  }
  if (typeof argumentsValue.name === "string" && argumentsValue.name)
    return argumentsValue.name;
  return "skill";
};

const definition = {
  key: "billingUsage",
  schema,
  init: () => ({
    context: null,
    samples: [],
    last: null,
    revision: 0,
    tools: { tools: {}, mcp: {}, skills: {} },
  }),
  apply: (state, event) => {
    // A retry can reuse the same turn/step. Resetting `last` here keeps usage
    // from separate provider requests additive, while streaming usage updates
    // within one request still replace their previous cumulative snapshot.
    if (event.type === "request/context")
      return { ...state, context: event.data, last: null };
    // 工具/技能/MCP 调用聚合：独立于 token 用量，仍推进 revision 以便增量同步。
    const baseTools = state.tools ?? { tools: {}, mcp: {}, skills: {} };
    if (event.type === "tool/call") {
      const name = typeof event.data?.name === "string" ? event.data.name : "";
      if (!name) return state;
      const tools = { ...baseTools };
      if (name.startsWith("mcp__")) {
        const server = name.split("__")[1];
        if (!server) return state;
        tools.mcp = increment(tools.mcp, server);
      } else if (name === "skill") {
        tools.skills = increment(tools.skills, parseSkillName(event.data?.arguments));
      } else {
        tools.tools = increment(tools.tools, name);
      }
      return { ...state, tools, revision: state.revision + 1 };
    }
    if (event.type === "user/message") {
      const source = event.data?.message?.source;
      if (
        source &&
        source.kind === "skill-invocation" &&
        typeof source.name === "string" &&
        source.name
      ) {
        const tools = { ...baseTools };
        tools.skills = increment(tools.skills, source.name);
        return { ...state, tools, revision: state.revision + 1 };
      }
      return state;
    }
    let turn;
    let step;
    let usage;
    if (event.type === "assistant/chunk" && event.data.chunk.type === "usage") {
      ({ turn, step } = event.data);
      usage = event.data.chunk.usage;
    } else if (
      event.type === "assistant/message" &&
      event.data.usage !== undefined
    ) {
      ({ turn, step, usage } = event.data);
    } else return state;
    if (!state.context) return state;
    const next = {
      provider: state.context.provider,
      model: state.context.model,
      time: event.time,
      ...fromUsage(usage),
    };
    const replacing =
      state.last && state.last.turn === turn && state.last.step === step;
    const samples = replacing
      ? [...state.samples.slice(0, -1), next]
      : [...state.samples, next];
    return {
      ...state,
      samples,
      last: { turn, step },
      revision: state.revision + 1,
    };
  },
  view: (state) => ({
    revision: String(state.revision),
    samples: state.samples,
    tools: state.tools,
  }),
  stateVersion: 4,
};

export const name = "desktop-billing";
export const inject = ["sessionProjections"];
export function apply(ctx) {
  ctx.sessionProjections.register(definition);
}
