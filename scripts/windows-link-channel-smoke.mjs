// Invoked only after the parent smoke verifies a disposable Windows runner.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

export async function exerciseLinkedChannels(cdp, { check, until, label }) {
  const apps = ["claude", "codex"];
  const name = "CI linked existing channel";
  const keys = {
    claude: "fake-link-original-claude-key",
    codex: "fake-link-original-codex-key",
    rotated: "fake-link-rotated-key",
    detached: "fake-link-detached-codex-key",
  };
  const ids = {
    claude: "ci-existing-claude",
    codex: "ci-existing-codex",
    similar: "ci-existing-similar-claude",
    managed: "ci-existing-managed-codex",
  };
  const requests = [];
  let upstreamHits = 0;
  const upstream = createServer(async (request, response) => {
    upstreamHits += 1;
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    if (new URL(request.url, "http://127.0.0.1").pathname.endsWith("/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"data":[{"id":"synthetic-linked-model"}]}');
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
              id: "msg_synthetic_linked",
              type: "message",
              role: "assistant",
              model: "synthetic-linked-claude",
              content: [{ type: "text", text: "synthetic linked result" }],
              stop_reason: "end_turn",
              stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 1 },
            }
          : {
              id: "resp_synthetic_linked",
              object: "response",
              status: "completed",
              model: "synthetic-linked-codex",
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
  const endpoints = {
    claude: `${base}/existing-claude/v1`,
    codex: `${base}/existing-codex/v1`,
  };
  const previous = {};
  for (const app of apps) {
    previous[app] = {
      current: await cdp.invoke("get_current_provider", { app }),
      config: await cdp.invoke("get_proxy_config_for_app", { appType: app }),
    };
    assert.ok(
      previous[app].current,
      "earlier smoke fixtures provide a fallback",
    );
  }
  const fixtures = {
    claude: {
      id: ids.claude,
      name: "CI original Claude configuration",
      category: "custom",
      icon: "anthropic",
      iconColor: "#D97757",
      websiteUrl: "https://claude-link.example.invalid",
      notes: "synthetic-private-claude-note",
      sortIndex: 12,
      settingsConfig: {
        env: {
          ANTHROPIC_BASE_URL: endpoints.claude,
          ANTHROPIC_API_KEY: keys.claude,
          ANTHROPIC_MODEL: "synthetic-linked-claude",
          CI_LINKED_ADVANCED_OPTION: "keep-original-claude-option",
        },
      },
      meta: { requestBudget: { firstByteTimeoutSecs: 17 } },
    },
    codex: {
      id: ids.codex,
      name: "CI original Codex configuration",
      category: "custom",
      icon: "openai",
      iconColor: "#00A67E",
      websiteUrl: "https://codex-link.example.invalid",
      notes: "synthetic-private-codex-note",
      sortIndex: 15,
      settingsConfig: {
        auth: { OPENAI_API_KEY: keys.codex },
        config: [
          'model = "synthetic-linked-codex"',
          'model_provider = "original_linked"',
          'approval_policy = "never"',
          'sandbox_mode = "workspace-write"',
          "model_context_window = 1000000",
          "[model_providers.original_linked]",
          'name = "Synthetic original channel"',
          `base_url = "${endpoints.codex}"`,
          'wire_api = "responses"',
          "requires_openai_auth = true",
          "[mcp_servers.synthetic_linked]",
          'command = "synthetic-unexecuted-command"',
          'args = ["synthetic-private-tool-argument"]',
          "",
        ].join("\n"),
      },
      meta: { requestBudget: { firstByteTimeoutSecs: 19 } },
    },
  };
  const added = [];
  const groups = {};
  const aliases = {};
  const channels = new Set();
  let started = false;
  let channel;
  const provider = async (app) =>
    (await cdp.invoke("get_providers", { app }))[ids[app]];
  const saved = (id = channel.id) =>
    cdp.invoke("get_universal_provider", { id });
  async function snapshot() {
    return {
      channels: await cdp.invoke("get_universal_providers"),
      claude: await cdp.invoke("get_providers", { app: "claude" }),
      codex: await cdp.invoke("get_providers", { app: "codex" }),
    };
  }
  async function assertReferences() {
    for (const app of apps) {
      assert.equal(await cdp.invoke("get_current_provider", { app }), ids[app]);
      assert.equal((await provider(app)).inFailoverQueue, true);
      assert.deepEqual(
        await cdp.invoke("get_routing_group", { id: groups[app].group.id }),
        groups[app],
      );
      assert.deepEqual(
        (await cdp.invoke("list_model_aliases", { appType: app })).find(
          (item) => item.id === aliases[app].id,
        ),
        aliases[app],
      );
    }
  }
  function assertSafePreview(value) {
    const serialized =
      typeof value === "string" ? value : JSON.stringify(value);
    for (const forbidden of [
      ...Object.values(keys),
      fixtures.claude.notes,
      fixtures.codex.notes,
      "synthetic-private-tool-argument",
      "synthetic-unexecuted-command",
      "settingsConfig",
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
    ])
      assert.ok(
        !serialized.includes(forbidden),
        `preview excludes ${forbidden}`,
      );
  }
  function assertPreserved(actual, original, expectedKey) {
    for (const field of [
      "id",
      "name",
      "icon",
      "iconColor",
      "websiteUrl",
      "notes",
      "sortIndex",
      "createdAt",
      "inFailoverQueue",
    ])
      assert.deepEqual(actual[field], original[field], field);
    assert.deepEqual(actual.meta.requestBudget, original.meta.requestBudget);
    if (actual.id === ids.claude) {
      assert.deepEqual(actual.settingsConfig, {
        ...original.settingsConfig,
        env: {
          ...original.settingsConfig.env,
          ANTHROPIC_API_KEY: expectedKey,
        },
      });
      assert.equal(actual.settingsConfig.env.ANTHROPIC_AUTH_TOKEN, undefined);
    } else {
      assert.equal(actual.settingsConfig.auth.OPENAI_API_KEY, expectedKey);
      for (const fragment of [
        'model = "synthetic-linked-codex"',
        'approval_policy = "never"',
        'sandbox_mode = "workspace-write"',
        "model_context_window = 1000000",
        "[mcp_servers.synthetic_linked]",
        'command = "synthetic-unexecuted-command"',
        'args = ["synthetic-private-tool-argument"]',
        endpoints.codex,
      ])
        assert.ok(actual.settingsConfig.config.includes(fragment), fragment);
    }
  }
  async function click(selector, pointer = false) {
    if (!pointer) {
      await until(
        () =>
          cdp.evaluate(`(() => {
          const button = document.querySelector(${JSON.stringify(selector)});
          if (!button || button.disabled || !button.getClientRects().length) return false;
          button.click();
          return true;
        })()`),
        `click enabled ${selector}`,
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
        return rect.width && rect.height ? {x:rect.x + rect.width/2,y:rect.y + rect.height/2} : false;
      })()`),
      `visible ${selector}`,
    );
    for (const type of ["mousePressed", "mouseReleased"])
      await cdp.send("Input.dispatchMouseEvent", {
        type,
        ...point,
        button: "left",
        clickCount: 1,
      });
  }
  async function setControl(testId, value, select = false) {
    assert.equal(
      await cdp.evaluate(`(() => {
        const control = document.querySelector(${JSON.stringify(`[data-testid="${testId}"]`)});
        if (!control) return false;
        Object.getOwnPropertyDescriptor(${select ? "HTMLSelectElement" : "HTMLInputElement"}.prototype, 'value').set.call(control, ${JSON.stringify(value)});
        control.dispatchEvent(new Event(${JSON.stringify(select ? "change" : "input")}, {bubbles:true}));
        return true;
      })()`),
      true,
      `set ${testId}`,
    );
  }
  async function openLinkForm() {
    await cdp.evaluate("location.reload()");
    await until(
      () =>
        cdp.evaluate(`(() => {
          const back = [...document.querySelectorAll('button:has(svg.lucide-arrow-left)')].at(-1);
          if (back) { back.click(); return false; }
          return !!document.querySelector('button[title="Add New Provider"],button[title="添加供应商"]');
        })()`),
      "show provider list for existing channel linking",
    );
    await click('button[title="Claude Code"]');
    await click('button[title="Add New Provider"],button[title="添加供应商"]');
    await click('[data-testid="shared-channel-tab"]', true);
    await click('[data-testid="shared-channel-link-open"]');
    await until(
      () =>
        cdp.evaluate(
          "!!document.querySelector('[data-testid=link-channel-name]')",
        ),
      "existing channel link form",
    );
    await setControl("link-channel-name", name);
    await until(
      () =>
        cdp.evaluate(`['claude', 'codex'].every(app => {
          const select = document.querySelector('[data-testid="link-channel-' + app + '"]');
          return select && !select.disabled && [...select.options].some(option => option.value === ${JSON.stringify(ids)}[app] && !option.disabled);
        })`),
      "load the two original candidates in the packaged form",
    );
    await setControl("link-channel-claude", ids.claude, true);
    await setControl("link-channel-codex", ids.codex, true);
    assert.equal(
      await cdp.evaluate(
        "document.querySelector('[data-testid=link-channel-key-source]').value",
      ),
      "",
      "linking requires an explicit key source",
    );
    await setControl("link-channel-key-source", "claude", true);
    await click('[data-testid="link-channel-preview"]');
    await until(
      () =>
        cdp.evaluate(
          "!!document.querySelector('[data-testid=link-channel-confirm]:not(:disabled)')",
        ),
      "safe preview before link confirmation",
    );
    assertSafePreview(
      await cdp.evaluate(
        "document.querySelector('[data-testid=link-channel-name]').closest('div.fixed.inset-0').outerHTML",
      ),
    );
  }
  async function save(value) {
    const result = await cdp.invoke("save_shared_channel", { provider: value });
    assert.equal(result.saved, true);
    assert.deepEqual(result.failedApps, []);
    return saved(value.id);
  }
  async function sendBoth(expectedKey) {
    const offset = requests.length;
    await Promise.all(
      apps.map(async (app) => {
        const response = await fetch(
          `http://127.0.0.1:15731/v1/${app === "claude" ? "messages" : "responses"}`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: "Bearer fake-local-link-key",
              "x-api-key": "fake-local-link-key",
            },
            body: JSON.stringify(
              app === "claude"
                ? {
                    model: "synthetic-linked-alias",
                    messages: [],
                    max_tokens: 8,
                    stream: false,
                  }
                : {
                    model: "synthetic-linked-alias",
                    input: "synthetic linked request",
                    store: false,
                    stream: false,
                  },
            ),
            signal: AbortSignal.timeout(20_000),
          },
        );
        assert.equal(response.status, 200);
        const result = await response.json();
        assert.equal(
          app === "claude" ? result.type : result.object,
          app === "claude" ? "message" : "response",
        );
      }),
    );
    const recent = requests.slice(offset);
    assert.equal(recent.length, 2);
    for (const app of apps) {
      const request = recent.find((item) =>
        item.path.startsWith(`/existing-${app}/v1/`),
      );
      assert.ok(request, `${app} retains its original endpoint path`);
      assert.equal(request.body.model, `synthetic-linked-${app}`);
      if (app === "claude") {
        assert.equal(request.apiKey, expectedKey);
      } else {
        assert.equal(request.authorization, `Bearer ${expectedKey}`);
      }
    }
  }
  try {
    for (const app of apps) {
      await cdp.invoke("add_provider", {
        app,
        provider: fixtures[app],
        addToLive: false,
      });
      added.push({ app, id: ids[app] });
      await cdp.invoke("switch_provider", { app, id: ids[app] });
      await cdp.invoke("update_proxy_config_for_app", {
        config: {
          ...previous[app].config,
          autoFailoverEnabled: false,
          sameProviderRetries: 0,
          rateLimitRetryEnabled: false,
        },
      });
      const group = await cdp.invoke("create_routing_group", {
        appType: app,
        name: `CI original ${app} references`,
      });
      await cdp.invoke("add_routing_group_member", {
        groupId: group.id,
        providerId: ids[app],
      });
      groups[app] = await cdp.invoke("get_routing_group", { id: group.id });
      aliases[app] = await cdp.invoke("upsert_model_alias", {
        appType: app,
        alias: "synthetic-linked-alias",
        providerId: ids[app],
        targetModel: `synthetic-linked-${app}`,
      });
    }
    for (const [app, id, extra] of [
      ["claude", ids.similar, {}],
      ["codex", ids.managed, { meta: { providerType: "codex_oauth" } }],
    ]) {
      await cdp.invoke("add_provider", {
        app,
        provider: {
          ...fixtures[app],
          ...extra,
          id,
          name: `CI unselected ${id}`,
        },
        addToLive: false,
      });
      added.push({ app, id });
    }
    const candidates = await cdp.invoke("list_shared_channel_link_candidates");
    assertSafePreview(candidates);
    for (const app of apps)
      assert.equal(
        candidates[app].find((item) => item.id === ids[app]).eligible,
        true,
      );
    const managed = candidates.codex.find((item) => item.id === ids.managed);
    assert.equal(managed.eligible, false);
    assert.equal(managed.reason, "managed_auth");
    check(
      `${label} link candidates expose safe labels and reject a synthetic managed-auth configuration`,
    );

    const beforeCancel = await snapshot();
    const hitsBeforePreview = upstreamHits;
    await openLinkForm();
    await cdp.screenshot(
      `${label.replaceAll(" ", "-")}-link-existing-preview.png`,
    );
    await click('[data-testid="link-channel-cancel"]');
    await until(
      () =>
        cdp.evaluate(
          "!document.querySelector('[data-testid=link-channel-name]')",
        ),
      "cancel existing channel link preview",
    );
    assert.deepEqual(await snapshot(), beforeCancel);
    assert.equal(
      upstreamHits,
      hitsBeforePreview,
      "preview does not probe upstream",
    );
    check(
      `${label} actual UI previews the chosen key source without secrets and cancellation writes nothing`,
    );

    const staleRequest = {
      channelId: randomUUID(),
      name: "CI stale link must not save",
      claudeProviderId: ids.claude,
      codexProviderId: ids.codex,
      keySource: "claude",
    };
    const stale = await cdp.invoke("preview_shared_channel_link", {
      request: staleRequest,
    });
    assertSafePreview(stale);
    assert.equal(stale.credentialsDiffer, true);
    assert.equal(stale.keySource, "claude");
    for (const app of apps) {
      const summary = stale.apps.find((item) => item.app === app);
      assert.equal(summary.providerId, ids[app]);
      assert.equal(summary.baseUrl, endpoints[app]);
      assert.equal(summary.current, true);
      assert.equal(summary.model, `synthetic-linked-${app}`);
    }
    const changed = await provider("claude");
    changed.settingsConfig.env.CI_LINKED_ADVANCED_OPTION =
      "changed-after-preview";
    await cdp.invoke("update_provider", { app: "claude", provider: changed });
    const beforeStaleCommit = await snapshot();
    await assert.rejects(
      cdp.invoke("link_existing_shared_channel", {
        request: staleRequest,
        token: stale.token,
      }),
    );
    assert.deepEqual(await snapshot(), beforeStaleCommit);
    check(
      `${label} a changed source invalidates the preview and rejects the entire stale link atomically`,
    );

    const originals = {
      claude: await provider("claude"),
      codex: await provider("codex"),
    };
    const beforeLink = await snapshot();
    await openLinkForm();
    await click('[data-testid="link-channel-confirm"]');
    channel = await until(
      async () =>
        Object.values(await cdp.invoke("get_universal_providers")).find(
          (item) => item.name === name,
        ),
      "link existing configurations from packaged UI",
    );
    channels.add(channel.id);
    await until(
      () =>
        cdp.evaluate(
          "!document.querySelector('[data-testid=link-channel-name]')",
        ),
      "finish projecting the linked channel and close its packaged form",
    );
    for (const app of apps) {
      assert.equal(channel.childIds[app], ids[app]);
      assert.equal((await provider(app)).meta.sharedChannelId, channel.id);
      assert.equal(
        Object.keys(await cdp.invoke("get_providers", { app })).length,
        Object.keys(beforeLink[app]).length,
      );
      assertPreserved(await provider(app), originals[app], keys.claude);
    }
    assert.deepEqual(
      (await cdp.invoke("get_providers", { app: "claude" }))[ids.similar],
      beforeLink.claude[ids.similar],
    );
    await assertReferences();
    check(
      `${label} actual UI links exactly the selected original IDs and preserves names, client settings, active choices, routing and aliases without merging a similar entry`,
    );

    await cdp.invoke("start_proxy_server");
    started = true;
    await sendBoth(keys.claude);
    check(
      `${label} original Claude API-key and Codex bearer transports use the chosen shared key on independent loopback paths and retain model aliases`,
    );

    const edited = await provider("claude");
    edited.settingsConfig.env.ANTHROPIC_MODEL =
      "synthetic-independent-linked-model";
    await cdp.invoke("update_provider", { app: "claude", provider: edited });
    assert.equal(
      (await provider("claude")).settingsConfig.env.ANTHROPIC_MODEL,
      "synthetic-independent-linked-model",
    );
    const beforeGuard = await snapshot();
    const bad = await provider("codex");
    bad.settingsConfig.auth.OPENAI_API_KEY = "fake-rejected-linked-override";
    await assert.rejects(
      cdp.invoke("update_provider", { app: "codex", provider: bad }),
    );
    await assert.rejects(
      cdp.invoke("delete_provider", { app: "codex", id: ids.codex }),
    );
    assert.deepEqual(await snapshot(), beforeGuard);
    check(
      `${label} custom-ID linked children allow independent model edits while direct credential overrides and deletion are rejected`,
    );

    for (const app of apps)
      await cdp.invoke("set_proxy_takeover_for_app", {
        appType: app,
        enabled: true,
      });
    channel = await save({ ...channel, apiKey: keys.rotated });
    await sendBoth(keys.rotated);
    for (const app of apps) {
      const live = await cdp.invoke("read_live_provider_settings", { app });
      assert.ok(JSON.stringify(live).includes("127.0.0.1:15731"));
    }
    await cdp.invoke("stop_proxy_with_restore");
    started = false;
    for (const app of apps) {
      const live = await cdp.invoke("read_live_provider_settings", { app });
      assert.ok(JSON.stringify(live).includes(keys.rotated));
      assert.ok(JSON.stringify(live).includes(endpoints[app]));
    }
    assert.equal(
      (await provider("claude")).settingsConfig.env.ANTHROPIC_MODEL,
      "synthetic-independent-linked-model",
    );
    assertPreserved(await provider("codex"), originals.codex, keys.rotated);
    await assertReferences();
    check(
      `${label} shared key rotation retains independent settings and proxy ownership, then stopping restores both original configurations with the latest key`,
    );

    const beforeSpoof = await snapshot();
    await assert.rejects(
      cdp.invoke("save_shared_channel", {
        provider: {
          ...channel,
          childIds: { ...channel.childIds, claude: ids.similar },
        },
      }),
    );
    await assert.rejects(
      cdp.invoke("save_shared_channel", {
        provider: {
          ...channel,
          id: randomUUID(),
          name: "CI forbidden mapped copy",
        },
      }),
    );
    assert.deepEqual(await snapshot(), beforeSpoof);
    check(
      `${label} ordinary shared-channel saves cannot replace original bindings or claim them through a copied channel`,
    );

    channel = await save({
      ...channel,
      apps: { ...channel.apps, claude: false },
    });
    assert.equal((await provider("claude")).meta?.sharedChannelId, undefined);
    assert.equal(
      (await provider("claude")).settingsConfig.env.ANTHROPIC_API_KEY,
      keys.rotated,
    );
    assert.equal((await provider("codex")).meta.sharedChannelId, channel.id);
    await assertReferences();
    check(
      `${label} disabling a linked client detaches its original row while preserving the current selection, references and latest credential`,
    );

    await cdp.invoke("delete_universal_provider", { id: channel.id });
    assert.equal(await saved(), null);
    channels.delete(channel.id);
    for (const app of apps)
      assert.equal((await provider(app)).meta?.sharedChannelId, undefined);
    await assertReferences();
    check(
      `${label} deleting the remaining linked channel preserves both original provider rows and all routing and alias references`,
    );

    const detached = await provider("codex");
    detached.settingsConfig.auth.OPENAI_API_KEY = keys.detached;
    await cdp.invoke("update_provider", { app: "codex", provider: detached });
    assert.equal(
      (await provider("codex")).settingsConfig.auth.OPENAI_API_KEY,
      keys.detached,
    );
    assert.equal(
      (await provider("claude")).settingsConfig.env.ANTHROPIC_API_KEY,
      keys.rotated,
    );
    check(
      `${label} detached original configurations can be edited independently without restoring or changing the other client's key`,
    );

    const reverseRequest = {
      ...staleRequest,
      channelId: randomUUID(),
      name: "CI explicit Codex key source",
      keySource: "codex",
    };
    const reverse = await cdp.invoke("preview_shared_channel_link", {
      request: reverseRequest,
    });
    assertSafePreview(reverse);
    assert.equal(reverse.credentialsDiffer, true);
    const relinked = await cdp.invoke("link_existing_shared_channel", {
      request: reverseRequest,
      token: reverse.token,
    });
    assert.equal(relinked.saved, true);
    assert.deepEqual(relinked.failedApps, []);
    channels.add(relinked.channelId);
    assert.equal(
      (await provider("claude")).settingsConfig.env.ANTHROPIC_API_KEY,
      keys.detached,
    );
    assert.equal(
      (await provider("codex")).settingsConfig.auth.OPENAI_API_KEY,
      keys.detached,
    );
    await assertReferences();
    check(
      `${label} explicitly choosing Codex as the key source also relinks the same original IDs without changing their references`,
    );
  } finally {
    try {
      if (started) await cdp.invoke("stop_proxy_with_restore");
      for (const id of channels)
        await cdp.invoke("delete_universal_provider", { id });
      for (const app of apps) {
        if (aliases[app])
          await cdp.invoke("delete_model_alias", {
            appType: app,
            id: aliases[app].id,
          });
        if (groups[app])
          await cdp.invoke("delete_routing_group", {
            id: groups[app].group.id,
          });
        await cdp.invoke("switch_provider", { app, id: previous[app].current });
        await cdp.invoke("update_proxy_config_for_app", {
          config: previous[app].config,
        });
      }
      for (const item of added) await cdp.invoke("delete_provider", item);
    } finally {
      upstream.closeAllConnections();
      await new Promise((done) => upstream.close(done));
    }
  }
}
