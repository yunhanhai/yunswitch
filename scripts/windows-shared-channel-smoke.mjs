// Invoked only after the parent smoke verifies a disposable Windows runner.
import assert from "node:assert/strict";
import { createServer } from "node:http";

export async function exerciseSharedChannels(cdp, { check, until, label }) {
  const apps = ["claude", "codex"];
  const name = "CI shared channel";
  const key = "fake-shared-channel-key";
  const rotatedKey = "fake-shared-channel-rotated-key";
  const takeoverKey = "fake-shared-channel-takeover-key";
  const independentCodexModel = "synthetic-codex-ui-model";
  const independentCodexNote = "synthetic Codex UI note";
  const requests = [];
  let upstreamHits = 0;
  const upstream = createServer(async (request, response) => {
    upstreamHits += 1;
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    if (new URL(request.url, "http://127.0.0.1").pathname.endsWith("/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"data":[{"id":"synthetic-shared-model"}]}');
      return;
    }
    requests.push({
      path: request.url,
      authorization: request.headers.authorization,
      apiKey: request.headers["x-api-key"],
      body: JSON.parse(Buffer.concat(chunks).toString()),
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify(
        request.url.endsWith("/messages")
          ? {
              id: "msg_synthetic_shared",
              type: "message",
              role: "assistant",
              model: "synthetic-shared-model",
              content: [{ type: "text", text: "synthetic shared result" }],
              stop_reason: "end_turn",
              stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 1 },
            }
          : request.url.endsWith("/chat/completions")
            ? {
                id: "chatcmpl_synthetic_shared",
                object: "chat.completion",
                created: 1,
                model: "synthetic-shared-model",
                choices: [
                  {
                    index: 0,
                    message: {
                      role: "assistant",
                      content: "synthetic shared result",
                    },
                    finish_reason: "stop",
                  },
                ],
                usage: {
                  prompt_tokens: 1,
                  completion_tokens: 1,
                  total_tokens: 2,
                },
              }
            : {
                id: "resp_synthetic_shared",
                object: "response",
                status: "completed",
                model: "synthetic-shared-model",
                output: [],
                usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
              },
      ),
    );
  });
  await new Promise((done, reject) =>
    upstream.once("error", reject).listen(0, "127.0.0.1", done),
  );
  const base = `http://127.0.0.1:${upstream.address().port}`;
  const previous = {};
  for (const app of apps) {
    previous[app] = {
      provider: await cdp.invoke("get_current_provider", { app }),
      config: await cdp.invoke("get_proxy_config_for_app", { appType: app }),
    };
    assert.ok(
      previous[app].provider,
      "earlier smoke fixtures provide a fallback",
    );
  }
  let channel;
  let started = false;
  let group;
  const childId = (app) => `universal-${app}-${channel.id}`;
  const child = async (app) =>
    (await cdp.invoke("get_providers", { app }))[childId(app)];
  const saved = () => cdp.invoke("get_universal_provider", { id: channel.id });
  async function save(provider) {
    const result = await cdp.invoke("save_shared_channel", { provider });
    assert.equal(result.saved, true);
    assert.deepEqual(result.failedApps, []);
    return result;
  }
  async function setInput(testId, value) {
    assert.equal(
      await cdp.evaluate(`(() => {
        const input = document.querySelector(${JSON.stringify(`[data-testid="${testId}"]`)});
        if (!input) return false;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
        input.dispatchEvent(new Event('input', {bubbles:true}));
        return true;
      })()`),
      true,
      `input ${testId}`,
    );
  }
  async function click(selector) {
    if (selector !== '[data-testid="shared-channel-tab"]') {
      await until(
        () =>
          cdp.evaluate(`(() => {
          const button = document.querySelector(${JSON.stringify(selector)});
          if (!button || button.disabled || !button.getClientRects().length) return false;
          button.click();
          return true;
        })()`),
        `click enabled control ${selector}`,
      );
      return;
    }
    const point = await until(
      () =>
        cdp.evaluate(`(() => {
        const button = document.querySelector(${JSON.stringify(selector)});
        if (!button || button.disabled) return false;
        button.scrollIntoView({block:'center'});
        const rect = button.getBoundingClientRect();
        if (!rect.width || !rect.height) return false;
        return {x:rect.x + rect.width/2,y:rect.y + rect.height/2};
      })()`),
      `visible enabled control ${selector}`,
    );
    // Radix tabs activate on pointer down; HTMLElement.click() does not produce
    // the input sequence of a user clicking the packaged WebView.
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      ...point,
      button: "left",
      clickCount: 1,
    });
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      ...point,
      button: "left",
      clickCount: 1,
    });
  }
  async function showProviderList(app = "claude") {
    await cdp.evaluate("location.reload()");
    await until(
      () =>
        cdp.evaluate(`(() => {
          const back = [...document.querySelectorAll('button:has(svg.lucide-arrow-left)')].at(-1);
          if (back) { back.click(); return false; }
          return !!document.querySelector('button[title="Add New Provider"],button[title="添加供应商"]');
        })()`),
      "show provider list for shared channel smoke",
    );
    await click(`button[title="${app === "codex" ? "Codex" : "Claude Code"}"]`);
  }
  async function typeInput(selector, value) {
    assert.equal(
      await cdp.evaluate(`(() => {
        const input = document.querySelector(${JSON.stringify(selector)});
        if (!input) return false;
        input.scrollIntoView({block:'center'});
        input.focus();
        input.select();
        return true;
      })()`),
      true,
      `focus ${selector}`,
    );
    await cdp.send("Input.insertText", { text: value });
    await until(
      () =>
        cdp.evaluate(
          `document.querySelector(${JSON.stringify(selector)})?.value === ${JSON.stringify(value)}`,
        ),
      `edit ${selector} through WebView keyboard input`,
    );
    await cdp.evaluate(
      `document.querySelector(${JSON.stringify(selector)}).blur()`,
    );
  }
  function assertCodexConnection(provider, expectedKey, expectedBase) {
    assert.equal(provider.meta.sharedChannelId, channel.id);
    assert.equal(provider.settingsConfig.auth.OPENAI_API_KEY, expectedKey);
    assert.equal(provider.settingsConfig.env?.OPENAI_API_KEY, undefined);
    assert.ok(provider.settingsConfig.config.includes(expectedBase));
    assert.match(provider.settingsConfig.config, /wire_api\s*=\s*"responses"/);
    assert.match(
      provider.settingsConfig.config,
      /requires_openai_auth\s*=\s*true/,
    );
    assert.ok(
      !provider.settingsConfig.config.includes("experimental_bearer_token"),
    );
    assert.ok(!provider.settingsConfig.config.includes("env_key"));
  }
  async function sendBoth(
    expectedKey,
    expectedPaths = ["/v1/messages", "/v1/responses"],
    expectConvertedCodex = false,
  ) {
    const offset = requests.length;
    await Promise.all(
      apps.map(async (app) => {
        const response = await fetch(
          `http://127.0.0.1:15731/v1/${app === "claude" ? "messages" : "responses"}`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: "Bearer fake-local-shared-key",
              "x-api-key": "fake-local-shared-key",
            },
            body: JSON.stringify(
              app === "claude"
                ? {
                    model: "synthetic-shared-claude",
                    messages: [],
                    max_tokens: 8,
                    stream: false,
                  }
                : {
                    model: "synthetic-shared-codex",
                    input: "synthetic request",
                    store: false,
                    stream: false,
                  },
            ),
            signal: AbortSignal.timeout(20_000),
          },
        );
        assert.equal(response.status, 200);
        const body = await response.json();
        if (app === "codex") {
          assert.equal(body.object, "response");
          assert.equal(body.status, "completed");
          if (expectConvertedCodex) {
            assert.ok(
              body.output.some((item) =>
                item.content?.some(
                  (part) =>
                    part.type === "output_text" &&
                    part.text === "synthetic shared result",
                ),
              ),
              "converted response preserves the synthetic text in Responses shape",
            );
          }
        } else {
          assert.equal(body.type, "message");
          assert.equal(body.stop_reason, "end_turn");
        }
      }),
    );
    const recent = requests.slice(offset);
    assert.equal(recent.length, 2);
    assert.deepEqual(
      recent.map((request) => request.path).sort(),
      [...expectedPaths].sort(),
    );
    for (const request of recent)
      assert.ok(
        request.authorization === `Bearer ${expectedKey}` ||
          request.apiKey === expectedKey,
        "each upstream protocol uses the shared credential",
      );
  }
  async function assertStoredUnchanged(before) {
    assert.deepEqual(await saved(), before.channel);
    for (const app of apps) assert.deepEqual(await child(app), before[app]);
  }
  async function snapshot() {
    return {
      channel: await saved(),
      claude: await child("claude"),
      codex: await child("codex"),
    };
  }
  try {
    // Use the actual packaged renderer for the one-entry, two-client flow.
    await showProviderList();
    await click('button[title="Add New Provider"],button[title="添加供应商"]');
    await until(
      () =>
        cdp.evaluate(
          "!!document.querySelector('[data-testid=shared-channel-tab]')",
        ),
      "shared channel creation tab",
    );
    await click('[data-testid="shared-channel-tab"]');
    await click('[data-testid="shared-channel-add"]');
    await until(
      () =>
        cdp.evaluate(
          "!!document.querySelector('[data-testid=shared-channel-name]')",
        ),
      "shared channel form",
    );
    assert.equal(
      await cdp.evaluate(
        "document.querySelector('[data-testid=shared-channel-app-claude]').getAttribute('aria-checked')",
      ),
      "true",
    );
    assert.equal(
      await cdp.evaluate(
        "document.querySelector('[data-testid=shared-channel-app-codex]').getAttribute('aria-checked')",
      ),
      "false",
      "new channel requires an explicit choice of the second client",
    );
    await setInput("shared-channel-name", name);
    await setInput("shared-channel-base-url", "synthetic-invalid-url");
    await cdp.evaluate(
      `window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', ctrlKey: true, bubbles: true }))`,
    );
    assert.equal(
      await cdp.evaluate(
        "document.querySelector('[data-testid=shared-channel-base-url]')?.value",
      ),
      "synthetic-invalid-url",
      "Settings shortcut preserves the shared-channel draft",
    );
    await setInput("shared-channel-api-key", key);
    await click('[data-testid="shared-channel-app-codex"]');
    await setInput("shared-channel-claude-model", "synthetic-shared-claude");
    await setInput("shared-channel-codex-model", "synthetic-shared-codex");
    await click('[data-testid="shared-channel-submit"]');
    await until(
      () => cdp.evaluate("!!document.querySelector('fieldset [role=alert]')"),
      "failed save keeps the shared channel form open",
    );
    assert.equal(
      await cdp.evaluate(
        "document.querySelector('[data-testid=shared-channel-api-key]')?.value",
      ),
      key,
      "a rejected save does not discard the entered draft",
    );
    assert.ok(
      !Object.values(await cdp.invoke("get_universal_providers")).some(
        (item) => item.name === name,
      ),
      "invalid input cannot leave a partially saved channel",
    );
    await setInput("shared-channel-base-url", base);
    await cdp.screenshot(
      `${label.replaceAll(" ", "-")}-shared-channel-create.png`,
    );
    await click('[data-testid="shared-channel-submit"]');
    channel = await until(async () => {
      const channels = await cdp.invoke("get_universal_providers");
      return Object.values(channels).find((item) => item.name === name);
    }, "save a shared channel from the packaged form");
    assert.deepEqual(channel.apps, {
      claude: true,
      codex: true,
      gemini: false,
    });
    for (const app of apps) {
      assert.equal((await child(app)).meta.sharedChannelId, channel.id);
      assert.equal(
        await cdp.invoke("get_current_provider", { app }),
        previous[app].provider,
        "saving a shared channel does not switch the active client",
      );
    }
    check(
      `${label} actual UI retains a rejected draft then adds one channel for two explicitly selected clients without switching either`,
    );

    await showProviderList();
    await until(
      () =>
        cdp.evaluate(
          `!!document.querySelector(${JSON.stringify(`[data-shared-channel-id="${channel.id}"]`)})`,
        ),
      "shared source entry on the client provider card",
    );
    await click(`[data-shared-channel-id="${channel.id}"]`);
    await until(
      () =>
        cdp.evaluate(
          `document.querySelector('[data-testid=shared-channel-name]')?.value === ${JSON.stringify(name)}`,
        ),
      "open the parent channel directly from its child",
    );
    assert.equal(
      await cdp.evaluate(
        "document.querySelector('[data-testid=shared-channel-api-key]').type",
      ),
      "password",
    );
    await cdp.screenshot(
      `${label.replaceAll(" ", "-")}-shared-channel-entry.png`,
    );
    check(
      `${label} actual child card opens its shared channel with the credential masked`,
    );
    await showProviderList();

    // Preview uses the same backend generation as saving, without persisting.
    const hitsBeforePreview = upstreamHits;
    const preview = await cdp.invoke("preview_shared_channel", {
      provider: {
        ...channel,
        connections: {
          claude: { baseUrl: `${base}/claude`, apiFormat: "openai_responses" },
          codex: { baseUrl: `${base}/codex`, apiFormat: "anthropic" },
        },
      },
    });
    assert.ok(!JSON.stringify(preview).includes(key));
    assert.equal(preview.claude.meta.apiFormat, "openai_responses");
    assert.equal(preview.codex.meta.apiFormat, "anthropic");
    assert.match(
      preview.codex.settingsConfig.config,
      /wire_api\s*=\s*"responses"/,
    );
    assert.equal(
      preview.claude.settingsConfig.env.ANTHROPIC_BASE_URL,
      `${base}/claude`,
    );
    assert.ok(preview.codex.settingsConfig.config.includes(`${base}/codex`));
    assert.deepEqual(await saved(), channel);
    assert.equal(
      upstreamHits,
      hitsBeforePreview,
      "preview never probes the upstream",
    );
    check(
      `${label} backend preview masks the key and keeps independent endpoints and protocols without writes or requests`,
    );

    let claude = await child("claude");
    let codex = await child("codex");
    claude.settingsConfig.env.ANTHROPIC_MODEL = "synthetic-independent-claude";
    claude.settingsConfig.env.CI_SYNTHETIC_OPTION = "preserve";
    claude.notes = "synthetic client-specific note";
    claude.meta.requestBudget = { firstByteTimeoutSecs: 17 };
    codex.settingsConfig.config = `approval_policy = "never"\nsandbox_mode = "workspace-write"\n${codex.settingsConfig.config.replace(/^model\s*=.*$/m, 'model = "synthetic-independent-codex"')}\n\n[mcp_servers.synthetic_shared]\ncommand = "synthetic-unexecuted-command"\nargs = ["synthetic-argument"]\n`;
    codex.notes = "synthetic Codex-specific note";
    codex.meta.requestBudget = { firstByteTimeoutSecs: 19 };
    for (const [app, provider] of [
      ["claude", claude],
      ["codex", codex],
    ])
      await cdp.invoke("update_provider", { app, provider });
    for (const app of apps) {
      await cdp.invoke("switch_provider", { app, id: childId(app) });
      await cdp.invoke("update_proxy_config_for_app", {
        config: { ...previous[app].config, autoFailoverEnabled: false },
      });
    }
    // Current Codex live files contain derived authentication fields. Editing
    // the linked child must use its owned settings, not save that projection.
    const currentLive = await cdp.invoke("read_live_provider_settings", {
      app: "codex",
    });
    assert.ok(currentLive.config.includes("experimental_bearer_token"));
    await showProviderList("codex");
    await until(
      () =>
        cdp.evaluate(
          `!!document.querySelector(${JSON.stringify(`[data-shared-channel-id="${channel.id}"]`)})`,
        ),
      "load the current linked Codex provider",
    );
    assert.equal(
      await cdp.evaluate(`(() => {
        let card = document.querySelector(${JSON.stringify(`[data-shared-channel-id="${channel.id}"]`)});
        const selector = 'button[title="Edit"],button[title="编辑"]';
        while (card && !card.querySelector(selector)) card = card.parentElement;
        const edit = card?.querySelector(selector);
        if (!edit) return false;
        edit.click();
        return true;
      })()`),
      true,
      "open the current linked Codex child editor",
    );
    await until(
      () => cdp.evaluate("!!document.querySelector('#codexDefaultModel')"),
      "render the current Codex provider editor",
    );
    await typeInput("#codexDefaultModel", independentCodexModel);
    await typeInput('input[name="notes"]', independentCodexNote);
    assert.equal(
      await cdp.evaluate(`(() => {
        const label = [...document.querySelectorAll('label')].find(item =>
          /^(1M Context Window|1M 上下文窗口)$/.test(item.textContent.trim()));
        const input = label?.querySelector('input[type=checkbox]');
        if (!input) return false;
        if (!input.checked) input.click();
        return true;
      })()`),
      true,
      "edit an independent Codex advanced option",
    );
    await cdp.screenshot(
      `${label.replaceAll(" ", "-")}-shared-channel-current-editor.png`,
    );
    await cdp.evaluate(`(() => {
      const original = window.fetch;
      window.__sharedEditProbe = {original, calls:0, completed:0, submits:0, invalid:[], response:null};
      const form=document.getElementById('provider-form');
      form.addEventListener('submit', () => window.__sharedEditProbe.submits += 1);
      form.addEventListener('invalid', (event) => window.__sharedEditProbe.invalid.push({id:event.target.id,name:event.target.name,type:event.target.type,message:event.target.validationMessage}), true);
      window.fetch = async function(input, ...rest) {
        const url = new URL(typeof input === 'string' ? input : input.url);
        const updating=url.hostname === 'ipc.localhost' && url.pathname === '/update_provider';
        if(updating) window.__sharedEditProbe.calls += 1;
        const response = await original.call(this, input, ...rest);
        if (updating) {
          window.__sharedEditProbe.completed += 1;
          window.__sharedEditProbe.response = await response.clone().text();
        }
        return response;
      };
    })()`);
    try {
      await click('button[type="submit"][form="provider-form"]');
      await until(async () => {
        const provider = await child("codex");
        return (
          provider.notes === independentCodexNote &&
          provider.settingsConfig.config.includes(independentCodexModel) &&
          /model_context_window\s*=\s*1000000/.test(
            provider.settingsConfig.config,
          )
        );
      }, "save the current linked Codex model, note and advanced option from the actual form");
    } catch (error) {
      const stored = await child("codex");
      const probe = await cdp.evaluate(
        `({calls:window.__sharedEditProbe.calls,completed:window.__sharedEditProbe.completed,submits:window.__sharedEditProbe.submits,invalid:window.__sharedEditProbe.invalid,response:window.__sharedEditProbe.response,model:document.querySelector('#codexDefaultModel')?.value,note:document.querySelector('input[name=notes]')?.value,errors:[...document.querySelectorAll('[role=alert],[data-sonner-toast]')].map(e=>e.textContent),text:document.body.innerText.slice(-3000)})`,
      );
      await cdp.screenshot(
        `${label.replaceAll(" ", "-")}-shared-channel-editor-failure.png`,
      );
      // Disposable-runner fixtures only. Deliberately omit auth and configuration text.
      process.stderr.write(
        JSON.stringify({
          sharedEdit: probe,
          storedNote: stored.notes,
          storedModelMatches: stored.settingsConfig.config.includes(
            independentCodexModel,
          ),
          storedContextMatches: /model_context_window\s*=\s*1000000/.test(
            stored.settingsConfig.config,
          ),
        }) + "\n",
      );
      throw error;
    } finally {
      await cdp.evaluate(
        "window.fetch = window.__sharedEditProbe.original; delete window.__sharedEditProbe;",
      );
    }
    assertCodexConnection(await child("codex"), key, base);
    await cdp.invoke("switch_provider", {
      app: "codex",
      id: previous.codex.provider,
    });
    codex = await child("codex");
    assertCodexConnection(codex, key, base);
    assert.equal(codex.notes, independentCodexNote);
    assert.ok(codex.settingsConfig.config.includes(independentCodexModel));
    assert.match(
      codex.settingsConfig.config,
      /model_context_window\s*=\s*1000000/,
    );
    await cdp.invoke("switch_provider", { app: "codex", id: childId("codex") });
    assertCodexConnection(await child("codex"), key, base);
    await showProviderList();
    check(
      `${label} current linked Codex model, note and advanced options save in the actual UI and survive switching away and back without changing shared authentication`,
    );
    await cdp.invoke("start_proxy_server");
    started = true;
    await sendBoth(key);
    check(
      `${label} both selected clients send concurrently to native loopback protocols using one shared credential`,
    );

    channel = {
      ...channel,
      connections: {
        claude: { baseUrl: `${base}/claude/v1`, apiFormat: "anthropic" },
        codex: { baseUrl: `${base}/codex/v1`, apiFormat: "openai_responses" },
      },
    };
    await save(channel);
    await sendBoth(key, ["/claude/v1/messages", "/codex/v1/responses"]);
    const savedConnections = (await saved()).connections;
    for (const app of apps)
      assert.deepEqual(savedConnections[app], channel.connections[app]);
    check(
      `${label} a shared key supports independent client addresses and native protocols without changing active selections`,
    );

    const nativeConnections = structuredClone(channel.connections);
    for (const [apiFormat, path] of [
      ["openai_chat", "/codex/v1/chat/completions"],
      ["anthropic", "/codex/v1/messages"],
    ]) {
      channel = {
        ...channel,
        connections: {
          ...nativeConnections,
          codex: { ...nativeConnections.codex, apiFormat },
        },
      };
      await save(channel);
      const convertedChild = await child("codex");
      assertCodexConnection(convertedChild, key, `${base}/codex/v1`);
      assert.equal(convertedChild.meta.apiFormat, apiFormat);
      const convertedLive = await cdp.invoke("read_live_provider_settings", {
        app: "codex",
      });
      assert.match(convertedLive.config, /wire_api\s*=\s*"responses"/);
      const offset = requests.length;
      await sendBoth(key, ["/claude/v1/messages", path], true);
      const convertedRequest = requests
        .slice(offset)
        .find((request) => request.path === path);
      assert.ok(Array.isArray(convertedRequest.body.messages));
      assert.equal(convertedRequest.body.input, undefined);
      assert.ok(
        JSON.stringify(convertedRequest.body.messages).includes(
          "synthetic request",
        ),
      );
      check(
        `${label} shared Codex ${apiFormat} upstream converts a bounded loopback request and response while its live wire remains Responses and Claude stays native`,
      );
    }
    channel = { ...channel, connections: nativeConnections };
    await save(channel);

    channel = {
      ...channel,
      apiKey: rotatedKey,
      baseUrl: `${base}/rotated/v1`,
      connections: {},
    };
    await save(channel);
    await sendBoth(rotatedKey, [
      "/rotated/v1/messages",
      "/rotated/v1/responses",
    ]);
    claude = await child("claude");
    codex = await child("codex");
    assert.equal(
      claude.settingsConfig.env.ANTHROPIC_MODEL,
      "synthetic-independent-claude",
    );
    assert.equal(claude.settingsConfig.env.CI_SYNTHETIC_OPTION, "preserve");
    assert.equal(claude.notes, "synthetic client-specific note");
    assert.equal(claude.meta.requestBudget.firstByteTimeoutSecs, 17);
    for (const fragment of [
      `model = "${independentCodexModel}"`,
      'approval_policy = "never"',
      'sandbox_mode = "workspace-write"',
      "[mcp_servers.synthetic_shared]",
      'command = "synthetic-unexecuted-command"',
    ])
      assert.ok(codex.settingsConfig.config.includes(fragment), fragment);
    assert.equal(codex.notes, independentCodexNote);
    assert.match(
      codex.settingsConfig.config,
      /model_context_window\s*=\s*1000000/,
    );
    assert.equal(codex.meta.requestBudget.firstByteTimeoutSecs, 19);
    for (const app of apps) {
      assert.equal(
        await cdp.invoke("get_current_provider", { app }),
        childId(app),
      );
      const live = await cdp.invoke("read_live_provider_settings", { app });
      assert.ok(
        JSON.stringify(live).includes(rotatedKey),
        "active client file uses rotated key",
      );
      assert.ok(
        JSON.stringify(live).includes(`${base}/rotated/v1`),
        "active client file uses rotated endpoint",
      );
    }
    for (const app of apps)
      await cdp.invoke("set_proxy_takeover_for_app", {
        appType: app,
        enabled: true,
      });
    channel = { ...channel, apiKey: takeoverKey };
    await save(channel);
    await sendBoth(takeoverKey, [
      "/rotated/v1/messages",
      "/rotated/v1/responses",
    ]);
    const takeover = await cdp.invoke("get_proxy_takeover_status");
    for (const app of apps) {
      assert.equal(takeover[app], true);
      const live = await cdp.invoke("read_live_provider_settings", { app });
      assert.ok(
        JSON.stringify(live).includes("127.0.0.1:15731"),
        "saving the shared channel preserves local routing ownership",
      );
    }
    await cdp.invoke("stop_proxy_with_restore");
    started = false;
    for (const app of apps) {
      const live = await cdp.invoke("read_live_provider_settings", { app });
      assert.ok(
        JSON.stringify(live).includes(takeoverKey),
        "stop restores the latest key",
      );
      assert.ok(
        JSON.stringify(live).includes(`${base}/rotated/v1`),
        "stop restores the latest endpoint",
      );
    }
    check(
      `${label} shared rotation preserves independent settings and takeover, then stop restores both clients with the latest key`,
    );

    const resynced = await cdp.invoke("resync_shared_channel", {
      id: channel.id,
    });
    assert.equal(resynced.saved, true);
    assert.deepEqual(resynced.failedApps, []);
    assert.deepEqual([...resynced.syncedApps].sort(), [...apps].sort());
    assertCodexConnection(
      await child("codex"),
      takeoverKey,
      `${base}/rotated/v1`,
    );
    assert.equal((await saved()).apiKey, takeoverKey);
    const beforeOverride = await snapshot();
    const envOverride = structuredClone(beforeOverride.codex);
    envOverride.settingsConfig.env = { OPENAI_API_KEY: "fake-stale-env-key" };
    await assert.rejects(
      cdp.invoke("update_provider", { app: "codex", provider: envOverride }),
    );
    await assertStoredUnchanged(beforeOverride);
    for (const providerType of ["codex_oauth", "github_copilot", "xai_oauth"]) {
      const managed = structuredClone(beforeOverride.codex);
      managed.meta.providerType = providerType;
      await assert.rejects(
        cdp.invoke("update_provider", { app: "codex", provider: managed }),
      );
      await assertStoredUnchanged(beforeOverride);
      await assert.rejects(
        cdp.invoke("save_shared_channel", {
          provider: { ...channel, meta: { providerType } },
        }),
      );
      await assertStoredUnchanged(beforeOverride);
    }
    check(
      `${label} retry projects the latest shared key and rejects environment-key or managed-account authentication overrides without database changes`,
    );

    const before = await snapshot();
    await assert.rejects(
      cdp.invoke("save_shared_channel", {
        provider: {
          ...channel,
          apiKey: "fake-rejected-key",
          apps: { ...channel.apps, claude: false },
        },
      }),
    );
    await assertStoredUnchanged(before);
    await assert.rejects(
      cdp.invoke("delete_universal_provider", { id: channel.id }),
    );
    await assertStoredUnchanged(before);
    const detached = structuredClone(claude);
    detached.settingsConfig.env.ANTHROPIC_AUTH_TOKEN = "fake-detached-key";
    await assert.rejects(
      cdp.invoke("update_provider", { app: "claude", provider: detached }),
    );
    await assertStoredUnchanged(before);
    check(
      `${label} active channel disable, delete and child credential detachment are rejected without partial database changes`,
    );

    for (const app of apps)
      await cdp.invoke("switch_provider", { app, id: previous[app].provider });
    const beforeRouteDelete = await snapshot();
    group = await cdp.invoke("create_routing_group", {
      appType: "claude",
      name: "CI shared channel references",
    });
    await cdp.invoke("add_routing_group_member", {
      groupId: group.id,
      providerId: childId("claude"),
    });
    await assert.rejects(
      cdp.invoke("delete_universal_provider", { id: channel.id }),
    );
    await assertStoredUnchanged(beforeRouteDelete);
    await cdp.invoke("delete_routing_group", { id: group.id });
    group = undefined;
    check(
      `${label} routing membership prevents deleting a shared channel even after switching clients away`,
    );

    channel = { ...channel, apps: { ...channel.apps, codex: false } };
    await save(channel);
    assert.equal(await child("codex"), undefined);
    assert.ok(await child("claude"));
    await cdp.invoke("delete_universal_provider", { id: channel.id });
    assert.equal(await saved(), null);
    assert.equal(await child("claude"), undefined);
    channel = undefined;
    check(
      `${label} unreferenced client disable and channel deletion remove only the associated synthetic providers`,
    );
  } finally {
    try {
      if (started) await cdp.invoke("stop_proxy_with_restore");
      if (group) await cdp.invoke("delete_routing_group", { id: group.id });
      for (const app of apps) {
        await cdp.invoke("switch_provider", {
          app,
          id: previous[app].provider,
        });
        await cdp.invoke("update_proxy_config_for_app", {
          config: previous[app].config,
        });
      }
      if (channel)
        await cdp.invoke("delete_universal_provider", { id: channel.id });
    } finally {
      upstream.closeAllConnections();
      await new Promise((done) => upstream.close(done));
    }
  }
}
