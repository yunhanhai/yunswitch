// Invoked only after the parent smoke verifies a disposable Windows runner.
import assert from "node:assert/strict";
import { createServer } from "node:http";

const frame = (type, value) =>
  `event: ${type}\ndata: ${JSON.stringify(value)}\n\n`;
const counters = [
  "total_requests",
  "pending_requests",
  "success_requests",
  "failed_requests",
  "timed_out_requests",
  "cancelled_requests",
  "unconfirmed_requests",
];

export async function exerciseRequestCompletion(cdp, { check, until, label }) {
  const model = "synthetic-completion-model";
  const marker = "synthetic-private-completion-content";
  const key = "fake-completion-key";
  const partial = frame("response.output_text.delta", {
    type: "response.output_text.delta",
    delta: marker,
  });
  const complete = frame("response.completed", {
    type: "response.completed",
    response: {
      id: "resp_synthetic_complete",
      status: "completed",
      output: [],
    },
  });
  const oversized = `data: ${"x".repeat(300 * 1024)}\n\n`;
  const hits = new Map();
  const held = new Set();
  const status = () => cdp.invoke("get_proxy_status");
  const snapshot = () => cdp.invoke("get_request_diagnostics");
  const upstream = createServer(async (request, response) => {
    response.on("error", () => {});
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    if (new URL(request.url, "http://127.0.0.1").pathname.endsWith("/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: model }] }));
      return;
    }
    const mode = JSON.parse(Buffer.concat(chunks).toString()).input;
    const count = (hits.get(mode) ?? 0) + 1;
    hits.set(mode, count);
    if (mode === "retry" && count === 1) {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(
        '{"error":{"code":"server_error","message":"synthetic-error"}}',
      );
      return;
    }
    if (mode === "json-failure") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          status: "failed",
          // Existing output forbids pre-output recovery, even with HTTP 200.
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: marker }],
            },
          ],
          error: { code: "server_error", message: marker },
        }),
      );
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (mode === "oversized") response.end(oversized);
    else if (mode === "partial") response.end(partial);
    else if (["complete-hold", "cancel", "timeout", "stop"].includes(mode)) {
      held.add(response);
      response.once("close", () => held.delete(response));
      response.write(mode === "complete-hold" ? complete : partial);
      if (mode !== "timeout") {
        // Keep cancellation/stop independent of the deliberately short idle
        // budget used by the separate timeout scenario.
        const heartbeat = setInterval(() => {
          if (!response.destroyed) response.write(": heartbeat\n\n");
        }, 200);
        response.once("close", () => clearInterval(heartbeat));
      }
    } else response.end(complete);
  });
  await new Promise((done, reject) =>
    upstream.once("error", reject).listen(0, "127.0.0.1", done),
  );
  const base = `http://127.0.0.1:${upstream.address().port}`;
  const previous = {
    provider: await cdp.invoke("get_current_provider", { app: "codex" }),
    config: await cdp.invoke("get_proxy_config_for_app", { appType: "codex" }),
  };
  const provider = {
    id: "yunswitch-ci-request-completion",
    name: "CI request completion",
    category: "custom",
    meta: { requestBudget: { idleTimeoutSecs: 1 } },
    settingsConfig: {
      base_url: `${base}/v1`,
      auth: { OPENAI_API_KEY: key },
      config: `model = "${model}"\nmodel_provider = "ci_completion"\n[model_providers.ci_completion]\nname = "CI completion"\nbase_url = "${base}/v1"\nwire_api = "responses"\nrequires_openai_auth = true\n`,
    },
  };
  let added = false;
  let started = false;
  function send(mode, signal = AbortSignal.timeout(20_000)) {
    return fetch("http://127.0.0.1:15731/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer fake-local-completion-key",
      },
      body: JSON.stringify({
        model,
        input: mode,
        stream: mode !== "json-failure",
        store: false,
      }),
      signal,
    });
  }
  async function checkpoint() {
    const data = await snapshot();
    return {
      status: await status(),
      ids: new Set([...data.active, ...data.recent].map(({ id }) => id)),
    };
  }
  async function assertDelta(before, expected) {
    const current = await until(async () => {
      const current = await status();
      return (
        current.pending_requests ===
          before.pending_requests + (expected.pending_requests ?? 0) && current
      );
    }, "settle request completion counters");
    for (const field of counters)
      assert.equal(current[field] - before[field], expected[field] ?? 0, field);
    const denominator =
      current.success_requests +
      current.failed_requests +
      current.timed_out_requests;
    const rate =
      denominator === 0 ? 0 : (current.success_requests / denominator) * 100;
    assert.ok(
      Math.abs(current.success_rate - rate) < 0.001,
      "success rate uses confirmed outcomes only",
    );
    const wire = await fetch("http://127.0.0.1:15731/status", {
      signal: AbortSignal.timeout(5000),
    }).then((response) => response.json());
    for (const field of counters)
      assert.equal(wire[field], current[field], `HTTP/IPC ${field}`);
    return current;
  }
  async function outcomes(before, phases, attempts = 1) {
    const rows = await until(async () => {
      const data = await snapshot();
      const rows = data.recent.filter(({ id }) => !before.ids.has(id));
      return rows.length === phases.length && rows;
    }, "archive each synthetic request once");
    assert.deepEqual(
      rows.map((row) => row.current.phase).sort(),
      [...phases].sort(),
    );
    const details = [];
    for (const row of rows) {
      const detail = await cdp.invoke("get_request_diagnostic_detail", {
        id: row.id,
      });
      assert.equal(detail.attempts, attempts);
      for (const privateValue of [marker, key, base])
        assert.ok(!JSON.stringify(detail).includes(privateValue));
      details.push(detail);
    }
    return details;
  }
  async function readFirst(mode) {
    const controller = new AbortController();
    const response = await send(
      mode,
      AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]),
    );
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const first = await reader.read();
    assert.equal(first.done, false);
    return { controller, reader };
  }
  try {
    await cdp.invoke("add_provider", {
      app: "codex",
      provider,
      addToLive: false,
    });
    added = true;
    await cdp.invoke("switch_provider", { app: "codex", id: provider.id });
    await cdp.invoke("update_proxy_config_for_app", {
      config: {
        ...previous.config,
        autoFailoverEnabled: false,
        sameProviderRetries: 1,
        sameProviderRetryBackoffMs: 20,
        sameProviderRetryMaxBackoffMs: 20,
        rateLimitRetryEnabled: false,
      },
    });
    await cdp.invoke("start_proxy_server");
    started = true;

    let before = await checkpoint();
    const [partialBody, completeBody] = await Promise.all(
      ["partial", "complete"].map(async (mode) => {
        const response = await send(mode);
        assert.equal(response.status, 200);
        return response.text();
      }),
    );
    assert.equal(partialBody, partial);
    assert.equal(completeBody, complete);
    const mixed = await outcomes(before, ["failed", "succeeded"]);
    assert.equal(
      mixed.find((row) => row.current.phase === "failed").current.error.class,
      "incomplete",
    );
    await assertDelta(before.status, {
      total_requests: 2,
      success_requests: 1,
      failed_requests: 1,
    });
    assert.equal(hits.get("partial"), 1);
    assert.equal(hits.get("complete"), 1);
    check(
      `${label} concurrent completion and partial EOF have matching diagnostics and final counts without replay`,
    );

    before = await checkpoint();
    const completed = await readFirst("complete-hold");
    await outcomes(before, ["succeeded"]);
    await assertDelta(before.status, {
      total_requests: 1,
      success_requests: 1,
    });
    completed.controller.abort();
    await completed.reader.cancel().catch(() => {});
    await assertDelta(before.status, {
      total_requests: 1,
      success_requests: 1,
    });
    assert.equal(hits.get("complete-hold"), 1);
    check(
      `${label} explicit completion stays successful when the client closes before upstream EOF`,
    );

    before = await checkpoint();
    const failed = await send("json-failure");
    assert.equal(failed.status, 200);
    assert.equal((await failed.json()).status, "failed");
    await outcomes(before, ["failed"]);
    await assertDelta(before.status, { total_requests: 1, failed_requests: 1 });
    assert.equal(hits.get("json-failure"), 1);
    check(
      `${label} HTTP 200 JSON semantic failure is counted and diagnosed as failed`,
    );

    before = await checkpoint();
    const large = await send("oversized");
    assert.equal(await large.text(), oversized);
    const unknown = await outcomes(before, ["unconfirmed"]);
    assert.equal(unknown[0].current.reason, "observationLimit");
    await assertDelta(before.status, {
      total_requests: 1,
      unconfirmed_requests: 1,
    });
    check(
      `${label} unobserved oversized output remains byte-identical and excludes unconfirmed outcomes from success rate`,
    );

    before = await checkpoint();
    assert.equal(await (await send("retry")).text(), complete);
    await outcomes(before, ["succeeded"], 2);
    await assertDelta(before.status, {
      total_requests: 1,
      success_requests: 1,
    });
    assert.equal(hits.get("retry"), 2);
    check(
      `${label} same-provider retry counts one request and one completed outcome`,
    );

    before = await checkpoint();
    const cancelled = await readFirst("cancel");
    await assertDelta(before.status, {
      total_requests: 1,
      pending_requests: 1,
    });
    cancelled.controller.abort();
    await cancelled.reader.cancel().catch(() => {});
    const cancellation = await outcomes(before, ["cancelled"]);
    assert.equal(cancellation[0].current.reason, "clientDisconnected");
    await assertDelta(before.status, {
      total_requests: 1,
      cancelled_requests: 1,
    });
    assert.equal(hits.get("cancel"), 1);
    check(
      `${label} client cancellation settles once and clears the pending request count`,
    );

    before = await checkpoint();
    await assert.rejects(async () => (await send("timeout")).text());
    await outcomes(before, ["timedOut"]);
    await assertDelta(before.status, {
      total_requests: 1,
      timed_out_requests: 1,
    });
    assert.equal(hits.get("timeout"), 1);
    check(
      `${label} output idle timeout is separate from ordinary failure and never replays`,
    );

    // Refresh the real renderer query after IPC setup, then inspect the visible
    // definition list rather than substituting a fixture into React state.
    await cdp.evaluate("location.reload()");
    await until(
      () =>
        cdp.evaluate(`(() => {
      if (document.querySelector('[role="tab"][id$="-trigger-proxy"]')) return true;
      const button = [...document.querySelectorAll('button[title]')].find(item => /^(Settings|设置)$/.test(item.title));
      button?.click(); return false;
    })()`),
      "open settings for completion counts",
    );
    await until(
      () =>
        cdp.evaluate(`(() => {
      const tab=document.querySelector('[role="tab"][id$="-trigger-proxy"]');
      if (!tab) return false;
      if (tab.getAttribute('aria-selected') === 'true') return true;
      tab.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0})); return false;
    })()`),
      "open routing for completion counts",
    );
    await until(
      () =>
        cdp.evaluate(`(() => {
      if ([...document.querySelectorAll('h4')].some(item => /^(Request outcomes|请求结果)$/.test(item.innerText))) return true;
      const button=[...document.querySelectorAll('button[aria-expanded]')].find(item => /Local Routing|本地路由/.test(item.innerText));
      if (button?.getAttribute('aria-expanded') === 'false') button.click();
      return false;
    })()`),
      "show request outcome summary in WebView",
    );
    const finalCounts = await status();
    const expectedUi = [
      finalCounts.success_requests,
      finalCounts.failed_requests,
      finalCounts.timed_out_requests,
      finalCounts.cancelled_requests,
      finalCounts.unconfirmed_requests,
      finalCounts.pending_requests,
    ];
    await until(async () => {
      const values = await cdp.evaluate(`(() => {
        const heading=[...document.querySelectorAll('h4')].find(item => /^(Request outcomes|请求结果)$/.test(item.innerText));
        if (!heading) return null;
        heading.parentElement.scrollIntoView({block:'center'});
        return [...heading.parentElement.querySelectorAll('dd')].map(item=>Number(item.innerText));
      })()`);
      return JSON.stringify(values) === JSON.stringify(expectedUi);
    }, "render backend completion counts in the real WebView");
    await cdp.screenshot(`${label.replaceAll(" ", "-")}-request-outcomes.png`);
    check(
      `${label} actual routing overview displays all six request outcome counters`,
    );

    before = await checkpoint();
    const stopped = await readFirst("stop");
    await assertDelta(before.status, {
      total_requests: 1,
      pending_requests: 1,
    });
    await cdp.invoke("stop_proxy_server");
    started = false;
    const stoppedRows = await outcomes(before, ["cancelled"]);
    assert.equal(stoppedRows[0].current.reason, "proxyStopped");
    stopped.controller.abort();
    await stopped.reader.cancel().catch(() => {});
    assert.equal((await snapshot()).active.length, 0);
    assert.equal((await status()).pending_requests, 0);
    await cdp.invoke("start_proxy_server");
    started = true;
    const restarted = await status();
    for (const field of counters)
      assert.equal(restarted[field], 0, `new run ${field}`);
    before = await checkpoint();
    assert.equal(await (await send("after-restart")).text(), complete);
    await outcomes(before, ["succeeded"]);
    await assertDelta(before.status, {
      total_requests: 1,
      success_requests: 1,
    });
    assert.equal(hits.get("stop"), 1);
    check(
      `${label} proxy stop cancels pending output and old completion cannot contaminate the restarted counters`,
    );
  } finally {
    try {
      if (started) await cdp.invoke("stop_proxy_server");
      await cdp.invoke("switch_provider", {
        app: "codex",
        id: previous.provider,
      });
      await cdp.invoke("update_proxy_config_for_app", {
        config: previous.config,
      });
      if (added)
        await cdp.invoke("delete_provider", { app: "codex", id: provider.id });
    } finally {
      for (const response of held) response.destroy();
      upstream.closeAllConnections();
      await new Promise((done) => upstream.close(done));
    }
  }
}
