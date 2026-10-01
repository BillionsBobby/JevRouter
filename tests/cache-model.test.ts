import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CachedJevProvider } from "../src/provider.js";
import type { CapabilityManifest, JevProvider, JevRawResponse, JevRouteRequest } from "../src/types.js";

const testCandidate: CapabilityManifest = {
  id: "test.capability",
  name: "Test capability",
  type: "skill",
  description: "A test capability",
  risk: { level: "low" },
};

class CountingProvider implements JevProvider {
  readonly name = "test-provider";
  readonly calls: JevRouteRequest[] = [];

  constructor(public model?: string) {}

  async decide(request: JevRouteRequest): Promise<JevRawResponse> {
    this.calls.push(request);
    const effectiveModel = request.model ?? this.model ?? "default";
    return {
      model: effectiveModel,
      answers: {
        tool: {
          type: "choice",
          choice: `tool-for-${effectiveModel}`,
          probabilities: { [`tool-for-${effectiveModel}`]: 1 },
          confidence: 1,
        },
      },
    };
  }
}

test("CachedJevProvider differentiates cache keys by request.model for identical request and candidates", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jevrouter-cache-test-"));
  try {
    const inner = new CountingProvider();
    const cached = new CachedJevProvider(inner, dir);

    const reqAlpha: JevRouteRequest = {
      state: "route this task",
      candidates: [testCandidate],
      model: "model-alpha",
    };
    const reqBeta: JevRouteRequest = {
      state: "route this task",
      candidates: [testCandidate],
      model: "model-beta",
    };

    // First call with model-alpha: triggers inner provider
    const resAlpha1 = await cached.decide(reqAlpha);
    assert.equal(inner.calls.length, 1);
    assert.equal(resAlpha1.model, "model-alpha");

    // Second call with same state & candidates but model-beta: must NOT reuse cache, triggers inner
    const resBeta1 = await cached.decide(reqBeta);
    assert.equal(inner.calls.length, 2);
    assert.equal(resBeta1.model, "model-beta");

    // Third call with model-alpha again: should hit cache
    const resAlpha2 = await cached.decide(reqAlpha);
    assert.equal(inner.calls.length, 2);
    assert.equal(resAlpha2.model, "model-alpha");

    // Fourth call with model-beta again: should hit cache
    const resBeta2 = await cached.decide(reqBeta);
    assert.equal(inner.calls.length, 2);
    assert.equal(resBeta2.model, "model-beta");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CachedJevProvider incorporates inner.model into cache key when request.model is omitted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jevrouter-cache-inner-"));
  try {
    const inner1 = new CountingProvider("model-v1");
    const cached1 = new CachedJevProvider(inner1, dir);
    assert.equal(cached1.model, "model-v1");

    const inner2 = new CountingProvider("model-v2");
    const cached2 = new CachedJevProvider(inner2, dir);
    assert.equal(cached2.model, "model-v2");

    const req: JevRouteRequest = {
      state: "route this task without explicit model",
      candidates: [testCandidate],
    };

    // First call with inner model-v1
    const res1 = await cached1.decide(req);
    assert.equal(inner1.calls.length, 1);
    assert.equal(res1.model, "model-v1");

    // Call on same cache directory with inner model-v2: must NOT reuse model-v1's response
    const res2 = await cached2.decide(req);
    assert.equal(inner2.calls.length, 1);
    assert.equal(res2.model, "model-v2");

    // Repeat calls should use cache
    const res1Again = await cached1.decide(req);
    assert.equal(inner1.calls.length, 1);
    assert.equal(res1Again.model, "model-v1");

    const res2Again = await cached2.decide(req);
    assert.equal(inner2.calls.length, 1);
    assert.equal(res2Again.model, "model-v2");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
