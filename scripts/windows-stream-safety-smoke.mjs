// Invoked only after the parent smoke validates a disposable Windows runner.
// These checks verify real packaged behavior. Source tests prove memory bounds;
// a process RSS sample is not evidence of bounded per-request collection.
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";

const frame = (type, value, newline = "\n") =>
  `event: ${type}${newline}data: ${JSON.stringify(value)}${newline}${newline}`;

export async function exerciseStreamSafety(cdp, { check, until, label }) {
  const fixture = label.replaceAll(" ", "-");
  const model = "synthetic-stream-safety";
  const outputMarker = "synthetic-visible-stream-output";
  const privateMarker = "synthetic-private-stream-content";
  const fakeKey = "fake-stream-safety-key";
  const snapshot = () => cdp.invoke("get_request_diagnostics");
  const before = {};
  const added = [];
  let started = false;
  let mode;
  let hits = 0;
  let upstreamResponse;
  let passthroughBytes;
  let fragmented = false;
  const upstream = createServer(async (request, response) => {
    response.on("error", () => {});
    for await (const _ of request) {
      /* No real client content or credentials are used. */
    }
    if (new URL(request.url, "http://127.0.0.1").pathname.endsWith("/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: model }] }));
      return;
    }
    hits += 1;
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (mode === "passthrough") {
      if (fragmented) {
        for (let offset = 0; offset < passthroughBytes.length; offset += 8191) {
          if (!response.write(passthroughBytes.subarray(offset, offset + 8191)))
            await once(response, "drain");
        }
        response.end();
      } else {
        response.end(passthroughBytes);
      }
      return;
    }
    upstreamResponse = response;
    if (mode === "chat") {
      response.write(
        `data: ${JSON.stringify({
          id: `chat_${fixture}`,
          model,
          choices: [{ delta: { content: outputMarker } }],
        })}\n\n`,
      );
    } else if (mode === "responses") {
      response.write(
        frame("response.created", {
          type: "response.created",
          response: { id: `resp_${fixture}`, model },
        }) +
          frame("response.output_text.delta", {
            type: "response.output_text.delta",
            item_id: "synthetic-output",
            output_index: 0,
            content_index: 0,
            delta: outputMarker,
          }),
      );
    } else {
      response.write(
        frame("message_start", {
          type: "message_start",
          message: { id: `msg_${fixture}`, model },
        }) +
          frame("content_block_start", {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          }) +
          frame("content_block_delta", {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: outputMarker },
          }),
      );
    }
    // The client destroys this socket only after observing actual output.
    // Closing it now could instead exercise the pre-output recovery path.
  });
  await new Promise((done, reject) =>
    upstream.once("error", reject).listen(0, "127.0.0.1", done),
  );
  const base = `http://127.0.0.1:${upstream.address().port}`;
  function provider(app, format) {
    const id = `yunswitch-ci-stream-${app}-${format}`;
    return {
      id,
      name: `CI stream safety ${app} ${format}`,
      category: "custom",
      meta: { apiFormat: format },
      settingsConfig:
        app === "claude"
          ? {
              env: {
                ANTHROPIC_BASE_URL: base,
                ANTHROPIC_AUTH_TOKEN: fakeKey,
              },
            }
          : {
              base_url: `${base}/v1`,
              auth: { OPENAI_API_KEY: fakeKey },
              config: `model = "${model}"\nmodel_provider = "ci_stream"\n[model_providers.ci_stream]\nname = "CI stream"\nbase_url = "${base}/v1"\nwire_api = "responses"\nrequires_openai_auth = true\n`,
            },
    };
  }
  async function select(app, format) {
    const value = provider(app, format);
    if (!added.some((item) => item.provider.id === value.id)) {
      await cdp.invoke("add_provider", {
        app,
        provider: value,
        addToLive: false,
      });
      added.push({ app, provider: value });
    }
    await cdp.invoke("switch_provider", { app, id: value.id });
  }
  async function send(app) {
    return fetch(
      `http://127.0.0.1:15731/v1/${app === "claude" ? "messages" : "responses"}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": "fake-local-stream-key",
          authorization: "Bearer fake-local-stream-key",
        },
        body: JSON.stringify({
          model,
          stream: true,
          ...(app === "claude"
            ? {
                messages: [{ role: "user", content: privateMarker }],
                max_tokens: 8,
              }
            : { input: privateMarker, store: false }),
        }),
        signal: AbortSignal.timeout(20_000),
      },
    );
  }
  const existingIds = async () => {
    const data = await snapshot();
    return new Set([...data.recent, ...data.active].map(({ id }) => id));
  };
  async function diagnostic(ids, phase) {
    const row = await until(async () => {
      const data = await snapshot();
      return data.recent.find((item) => !ids.has(item.id));
    }, "finish the synthetic stream diagnostic");
    const detail = await cdp.invoke("get_request_diagnostic_detail", {
      id: row.id,
    });
    assert.equal(detail.current.phase, phase);
    assert.equal(detail.attempts, 1);
    const serialized = JSON.stringify(detail);
    for (const value of [privateMarker, fakeKey, outputMarker, base])
      assert.ok(!serialized.includes(value));
    return detail;
  }
  try {
    assert.equal((await cdp.invoke("get_proxy_config")).enable_logging, true);
    for (const app of ["claude", "codex"]) {
      before[app] = {
        provider: await cdp.invoke("get_current_provider", { app }),
        config: await cdp.invoke("get_proxy_config_for_app", { appType: app }),
      };
      await cdp.invoke("update_proxy_config_for_app", {
        config: {
          ...before[app].config,
          autoFailoverEnabled: false,
          sameProviderRetries: 2,
          rateLimitRetryEnabled: false,
        },
      });
    }
    await select("claude", "anthropic");
    await cdp.invoke("start_proxy_server");
    started = true;

    for (fragmented of [false, true]) {
      const messageId = `msg_stream_safety_${fixture}_${fragmented}`;
      mode = "passthrough";
      hits = 0;
      const ids = await existingIds();
      const events = [
        frame("message_start", {
          type: "message_start",
          message: {
            id: messageId,
            model,
            usage: {
              input_tokens: 17,
              output_tokens: 0,
              cache_read_input_tokens: 5,
              cache_creation_input_tokens: 3,
            },
          },
        }),
        // One event exceeds both the diagnostic and usage observer limits.
        // It remains client data and must reach the client byte-for-byte.
        frame(
          "content_block_delta",
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "合成".repeat(131072) },
            usage: { private_data: privateMarker },
          },
          "\r\n",
        ),
      ];
      for (let count = 1; count <= 2048; count += 1)
        events.push(
          frame("message_delta", {
            type: "message_delta",
            usage: { output_tokens: count },
            ignored_body: privateMarker,
          }),
        );
      events.push(
        frame("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
        }),
        frame("message_stop", { type: "message_stop" }),
      );
      passthroughBytes = Buffer.from(events.join(""));
      const response = await send("claude");
      assert.equal(response.status, 200);
      const result = Buffer.from(await response.arrayBuffer());
      assert.ok(
        result.equals(passthroughBytes),
        "SSE bytes changed in transit",
      );
      assert.equal(hits, 1);
      const usage = await until(
        () =>
          cdp.invoke("get_request_detail", {
            requestId: `session:${messageId}`,
          }),
        "record usage after oversized SSE and repeated cumulative events",
      );
      assert.equal(usage.inputTokens, 17);
      assert.equal(usage.outputTokens, 2048);
      assert.equal(usage.cacheReadTokens, 5);
      assert.equal(usage.cacheCreationTokens, 3);
      assert.equal(usage.model, model);
      assert.ok(!JSON.stringify(usage).includes(privateMarker));
      await diagnostic(ids, "succeeded");
      check(
        `${label} ${fragmented ? "fragmented" : "single-write"} oversized SSE stays byte-identical and later cumulative usage retains input and cache counts`,
        { forwardedBytes: result.length, usageEvents: 2048 },
      );
    }

    for (const scenario of [
      { app: "claude", format: "openai_chat", upstream: "chat" },
      { app: "claude", format: "openai_responses", upstream: "responses" },
      { app: "codex", format: "openai_chat", upstream: "chat" },
      { app: "codex", format: "anthropic", upstream: "anthropic" },
    ]) {
      await select(scenario.app, scenario.format);
      mode = scenario.upstream;
      hits = 0;
      upstreamResponse = undefined;
      const ids = await existingIds();
      const response = await send(scenario.app);
      assert.equal(response.status, 200);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let body = "";
      while (!body.includes(outputMarker)) {
        const next = await reader.read();
        assert.equal(next.done, false, "stream ended before visible output");
        body += decoder.decode(next.value, { stream: true });
      }
      assert.ok(upstreamResponse);
      upstreamResponse.destroy();
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        body += decoder.decode(next.value, { stream: true });
      }
      body += decoder.decode();
      const values = body
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data: "))
        .map((line) => JSON.parse(line.slice(6)));
      const terminal = values.at(-1);
      const error =
        scenario.app === "codex" ? terminal.response.error : terminal.error;
      assert.equal(
        terminal.type,
        scenario.app === "codex" ? "response.failed" : "error",
      );
      assert.equal(error.type, "stream_error");
      assert.equal(error.message, "Upstream stream was interrupted.");
      assert.ok(!body.includes("event: response.completed"));
      assert.ok(!body.includes("event: message_stop"));
      for (const value of [privateMarker, fakeKey, base])
        assert.ok(!JSON.stringify(error).includes(value));
      assert.equal(hits, 1, "output must never be automatically replayed");
      const detail = await diagnostic(ids, "failed");
      assert.ok(detail.steps.some((step) => step.phase === "streaming"));
      check(
        `${label} ${scenario.upstream} to ${scenario.app === "codex" ? "Responses" : "Messages"} socket failure has a safe error, failed diagnosis and no replay or success terminal`,
      );
    }
  } finally {
    try {
      if (started) await cdp.invoke("stop_proxy_server");
      for (const [app, previous] of Object.entries(before)) {
        await cdp.invoke("switch_provider", { app, id: previous.provider });
        await cdp.invoke("update_proxy_config_for_app", {
          config: previous.config,
        });
      }
      for (const { app, provider: value } of added)
        await cdp.invoke("delete_provider", { app, id: value.id });
    } finally {
      upstream.closeAllConnections();
      await new Promise((done) => upstream.close(done));
    }
  }
}
