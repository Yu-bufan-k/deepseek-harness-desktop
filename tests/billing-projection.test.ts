import { describe, expect, it } from "vitest";
// The Harness plugin is intentionally shipped as runtime JavaScript.
// @ts-expect-error No declaration file is emitted for this local plugin.
import { apply } from "../plugins/billing/index.js";

interface BillingTools {
  tools: Record<string, number>;
  mcp: Record<string, number>;
  skills: Record<string, number>;
}
interface ProjectionState {
  context: { provider: string; model: string } | null;
  samples: unknown[];
  last: unknown;
  revision: number;
  tools?: BillingTools;
}
interface ProjectionEvent {
  type: string;
  time?: number;
  data?: Record<string, unknown>;
}
interface ProjectionDefinition {
  init(): ProjectionState;
  apply(state: ProjectionState, event: ProjectionEvent): ProjectionState;
  view(state: ProjectionState): {
    revision: string;
    samples: unknown[];
    tools: BillingTools;
  };
  stateVersion: number;
}

function definition(): ProjectionDefinition {
  let registered: ProjectionDefinition | undefined;
  apply({
    sessionProjections: {
      register(value: ProjectionDefinition) {
        registered = value;
      },
    },
  });
  if (!registered) throw new Error("billing projection was not registered");
  return registered;
}

describe("billing projection", () => {
  it("increments revisions for stream replacements and separate retries", () => {
    const projection = definition();
    let state = projection.init();
    state = projection.apply(state, {
      type: "request/context",
      data: { provider: "p", model: "m" },
    });
    state = projection.apply(state, {
      type: "assistant/chunk",
      time: 1,
      data: {
        turn: 1,
        step: 1,
        chunk: { type: "usage", usage: { inputTokens: 10, outputTokens: 1 } },
      },
    });
    expect(projection.view(state)).toMatchObject({
      revision: "1",
      samples: [{ provider: "p", model: "m", uncachedInputTokens: 10 }],
    });
    state = projection.apply(state, {
      type: "assistant/chunk",
      time: 2,
      data: {
        turn: 1,
        step: 1,
        chunk: { type: "usage", usage: { inputTokens: 20, outputTokens: 2 } },
      },
    });
    expect(projection.view(state)).toMatchObject({
      revision: "2",
      samples: [{ uncachedInputTokens: 20 }],
    });
    state = projection.apply(state, {
      type: "request/context",
      data: { provider: "p", model: "m" },
    });
    state = projection.apply(state, {
      type: "assistant/message",
      time: 3,
      data: { turn: 1, step: 1, usage: { inputTokens: 5, outputTokens: 1 } },
    });
    expect(projection.view(state)).toMatchObject({ revision: "3" });
    expect(projection.view(state).samples).toHaveLength(2);
    expect(projection.stateVersion).toBe(4);
  });

  it("聚合工具 / MCP / 技能调用并推进 revision", () => {
    const projection = definition();
    let state = projection.init();
    state = projection.apply(state, {
      type: "request/context",
      data: { provider: "p", model: "m" },
    });
    state = projection.apply(state, {
      type: "tool/call",
      data: { turn: 1, step: 1, callId: "a", name: "memory_search", arguments: "{}" },
    });
    state = projection.apply(state, {
      type: "tool/call",
      data: { turn: 1, step: 2, callId: "b", name: "mcp__files__read_file", arguments: "{}" },
    });
    state = projection.apply(state, {
      type: "tool/call",
      data: { turn: 1, step: 3, callId: "c", name: "mcp__files__list", arguments: "{}" },
    });
    state = projection.apply(state, {
      type: "tool/call",
      data: { turn: 1, step: 4, callId: "d", name: "skill", arguments: '{"name":"my-skill"}' },
    });
    state = projection.apply(state, {
      type: "user/message",
      data: { turn: 2, step: 1, message: { source: { kind: "skill-invocation", name: "other-skill" } } },
    });
    const view = projection.view(state);
    expect(view.revision).toBe("5");
    expect(view.tools).toEqual({
      tools: { memory_search: 1 },
      mcp: { files: 2 },
      skills: { "my-skill": 1, "other-skill": 1 },
    });
  });

  it("容忍旧版投影状态缺少 tools 字段（迁移防御）", () => {
    const projection = definition();
    const legacy = {
      context: { provider: "p", model: "m" },
      samples: [],
      last: null,
      revision: 0,
    };
    const state = projection.apply(legacy, {
      type: "tool/call",
      data: { name: "x", arguments: "" },
    });
    expect(state.tools).toEqual({ tools: { x: 1 }, mcp: {}, skills: {} });
    expect(projection.view(state).revision).toBe("1");
  });
});
