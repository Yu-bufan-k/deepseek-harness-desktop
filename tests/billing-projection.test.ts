import { describe, expect, it } from "vitest";
// The Harness plugin is intentionally shipped as runtime JavaScript.
// @ts-expect-error No declaration file is emitted for this local plugin.
import { apply } from "../plugins/billing/index.js";

interface ProjectionState {
  context: { provider: string; model: string } | null;
  samples: unknown[];
  last: unknown;
  revision: number;
}
interface ProjectionEvent {
  type: string;
  time?: number;
  data?: Record<string, unknown>;
}
interface ProjectionDefinition {
  init(): ProjectionState;
  apply(state: ProjectionState, event: ProjectionEvent): ProjectionState;
  view(state: ProjectionState): { revision: string; samples: unknown[] };
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
    expect(projection.stateVersion).toBe(3);
  });
});
