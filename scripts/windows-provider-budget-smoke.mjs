// Invoked only after the parent smoke script validates a disposable Windows runner.
import assert from "node:assert/strict";
import { createServer } from "node:http";

export async function exerciseProviderBudgets(cdp, { check, until, label }) {
  let mode = "slow";
  let hits = 0;
  const upstream = createServer(async (req, res) => {
    for await (const _ of req) {
      /* synthetic request only */
    }
    if (new URL(req.url, "http://127.0.0.1").pathname.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"data":[{"id":"synthetic-budget"}]}');
      return;
    }
    hits += 1;
    if (mode === "slow") {
      setTimeout(() => {
        if (!res.destroyed) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end('{"type":"message","content":[]}');
        }
      }, 1800);
    } else if (mode === "retry") {
      res.writeHead(503);
      res.end("synthetic-private-budget-error");
    } else if (mode === "limit") {
      res.writeHead(429, { "retry-after": "5" });
      res.end();
    } else {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        'event: message_start\ndata: {"type":"message_start","message":{"id":"synthetic","type":"message","role":"assistant","content":[]}}\n\n',
      );
      setTimeout(() => {
        if (!res.destroyed)
          res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
      }, 1600);
    }
  });
  await new Promise((done) => upstream.listen(0, "127.0.0.1", done));
  const before = await cdp.invoke("get_proxy_config_for_app", {
    appType: "claude",
  });
  const previous = await cdp.invoke("get_current_provider", { app: "claude" });
  const provider = {
    id: "yunswitch-ci-budget",
    name: "CI request budget",
    category: "custom",
    settingsConfig: {
      env: {
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstream.address().port}`,
        ANTHROPIC_AUTH_TOKEN: "fake-budget-key",
      },
    },
    meta: {
      requestBudget: {
        firstByteTimeoutSecs: 1,
        idleTimeoutSecs: 1,
        nonStreamingTimeoutSecs: 1,
        recoveryTimeoutSecs: 2,
      },
    },
  };
  let started = false;
  async function send(stream = false, signal = AbortSignal.timeout(10000)) {
    const response = await fetch("http://127.0.0.1:15731/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "fake-local-budget-key",
      },
      body: JSON.stringify({
        model: "synthetic-budget",
        messages: [],
        max_tokens: 8,
        stream,
      }),
      signal,
    });
    return { status: response.status, text: await response.text() };
  }
  const latest = async () => {
    const data = await cdp.invoke("get_request_diagnostics");
    return cdp.invoke("get_request_diagnostic_detail", {
      id: data.recent[0].id,
    });
  };
  try {
    await cdp.invoke("add_provider", {
      app: "claude",
      provider,
      addToLive: false,
    });
    await cdp.invoke("switch_provider", { app: "claude", id: provider.id });
    await cdp.invoke("update_proxy_config_for_app", {
      config: {
        ...before,
        autoFailoverEnabled: false,
        sameProviderRetries: 2,
        sameProviderRetryBackoffMs: 5000,
        sameProviderRetryMaxBackoffMs: 5000,
        rateLimitRetryEnabled: true,
        rateLimitMaxWaitSecs: 10,
      },
    });
    await cdp.invoke("start_proxy_server");
    started = true;

    // Edit the saved provider in the actual renderer, then read back the values.
    // Direct IPC fixture setup does not invalidate React Query's provider list.
    await cdp.evaluate("location.reload()");
    await until(
      () =>
        cdp.evaluate(`(() => {
      if (document.querySelector('button[title="Add New Provider"],button[title="添加供应商"]')) return true;
      document.querySelector('button:has(svg.lucide-arrow-left)')?.click();
      return false;
    })()`),
      "return to provider list after refreshing synthetic fixture",
    );
    await cdp.evaluate(
      "document.querySelector('button[title=\"Claude Code\"]')?.click()",
    );
    await until(
      () =>
        cdp.evaluate(
          "[...document.querySelectorAll('h3')].some(item => item.textContent === 'CI request budget')",
        ),
      "load synthetic provider into renderer cache",
    );
    assert.equal(
      await cdp.evaluate(`(() => {
      const text = [...document.querySelectorAll('h3')].find(item => item.textContent === 'CI request budget');
      let card = text;
      while (card && !card.querySelector('button[title="Edit"],button[title="编辑"],button:has(svg.lucide-pencil)')) card = card.parentElement;
      const edit = card?.querySelector('button[title="Edit"],button[title="编辑"],button:has(svg.lucide-pencil)');
      if (!edit) return false;
      edit.click();
      return true;
    })()`),
      true,
    );
    await until(
      () =>
        cdp.evaluate(
          "!!document.querySelector('[data-request-budget=\"recoveryTimeoutSecs\"]')",
        ),
      "render saved budget fields",
    );
    assert.deepEqual(
      await cdp.evaluate(
        "Object.fromEntries([...document.querySelectorAll('[data-request-budget]')].map(input => [input.dataset.requestBudget,Number(input.value)]))",
      ),
      provider.meta.requestBudget,
    );
    await cdp.evaluate(`(() => {
      const input = document.querySelector('[data-request-budget="recoveryTimeoutSecs"]');
      input.focus();
      input.select();
      input.scrollIntoView({block:'center'});
    })()`);
    await cdp.send("Input.insertText", { text: "3" });
    const budgetInputState = await cdp.evaluate(`(() => {
      const input=document.querySelector('[data-request-budget="recoveryTimeoutSecs"]');
      return {value:input?.value,disabled:input?.matches(':disabled'),inert:!!input?.closest('[inert]'),active:document.activeElement?.id,inputs:document.querySelectorAll('[data-request-budget="recoveryTimeoutSecs"]').length,dialogs:[...document.querySelectorAll('[role="dialog"]')].map(item=>item.innerText)};
    })()`);
    process.stdout.write(`BUDGET_INPUT ${JSON.stringify(budgetInputState)}\n`);
    await cdp.screenshot(
      `${label.replaceAll(" ", "-")}-budget-input-probe.png`,
    );
    await until(
      () =>
        cdp.evaluate(
          "document.querySelector('[data-request-budget=\"recoveryTimeoutSecs\"]')?.value === '3'",
        ),
      "enter budget through WebView keyboard input",
    );
    await cdp.evaluate(
      "document.querySelector('[data-request-budget=\"recoveryTimeoutSecs\"]').blur()",
    );
    await until(
      () =>
        cdp.evaluate(
          "document.querySelector('[data-request-budget=\"recoveryTimeoutSecs\"]')?.value === '3'",
        ),
      "retain edited budget after blur",
    );
    await cdp.screenshot(
      `${label.replaceAll(" ", "-")}-provider-request-budget.png`,
    );
    assert.equal(
      await cdp.evaluate(`(() => {
      const button=document.querySelector('button[type="submit"][form="provider-form"],form button[type="submit"]');
      if(!button || button.disabled) return false;
      button.click(); return true;
    })()`),
      true,
    );
    try {
      await until(async () => {
        const providers = await cdp.invoke("get_providers", { app: "claude" });
        return (
          providers[provider.id]?.meta?.requestBudget?.recoveryTimeoutSecs === 3
        );
      }, "persist budget changed in actual provider form");
    } catch (error) {
      await cdp.screenshot(
        `${label.replaceAll(" ", "-")}-provider-budget-save-failed.png`,
      );
      throw error;
    }
    await cdp.evaluate(
      "window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))",
    );
    check(
      `${label} provider request budget fields load, edit and persist in the actual form`,
    );

    hits = 0;

    assert.equal((await send()).status, 504);
    assert.equal(hits, 1);
    assert.equal((await latest()).current.phase, "timedOut");
    check(`${label} provider timeout applies with failover disabled`);

    mode = "retry";
    hits = 0;
    const result = await send();
    assert.equal(result.status, 504);
    assert.equal(hits, 1);
    const trace = await latest();
    assert.equal(trace.current.error.class, "recoveryBudget");
    assert.equal(trace.current.phase, "timedOut");
    assert.ok(
      !JSON.stringify(trace).includes("synthetic-private-budget-error"),
    );
    check(
      `${label} total provider budget stops retry backoff and reports safe diagnostic timeout`,
    );

    mode = "limit";
    hits = 0;
    const waits = await Promise.all([send(), send()]);
    assert.ok(waits.every((response) => response.status === 504));
    assert.equal(hits, 2);
    await until(
      async () => !(await cdp.invoke("get_proxy_status")).rate_limit_waiting,
      "clear budget-limited waits",
    );
    check(
      `${label} concurrent provider budgets stop cooldown and recovery queue without extra sends`,
    );

    mode = "stream";
    hits = 0;
    let failed = false;
    try {
      await send(true);
    } catch {
      failed = true;
    }
    assert.equal(failed, true);
    assert.equal(hits, 1);
    assert.equal((await latest()).current.phase, "timedOut");
    check(`${label} provider stream idle timeout never replays output`);

    mode = "retry";
    hits = 0;
    const controller = new AbortController();
    const cancelled = send(false, controller.signal).catch(() => null);
    await until(
      () => hits === 1,
      "reach upstream before cancelling budgeted retry",
    );
    controller.abort();
    await cancelled;
    await until(
      async () =>
        (await cdp.invoke("get_request_diagnostics")).active.length === 0,
      "clear cancelled budgeted request",
    );
    assert.equal(hits, 1);
    check(`${label} cancellation clears budgeted retry and sends no replay`);
  } finally {
    if (started) await cdp.invoke("stop_proxy_server").catch(() => {});
    await cdp.invoke("switch_provider", { app: "claude", id: previous });
    await cdp.invoke("update_proxy_config_for_app", { config: before });
    await cdp.invoke("delete_provider", { app: "claude", id: provider.id });
    upstream.closeAllConnections();
    await new Promise((done) => upstream.close(done));
  }
}
