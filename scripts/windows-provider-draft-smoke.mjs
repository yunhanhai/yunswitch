// Runs only inside the fresh Windows runner guarded by windows-release-smoke.mjs.
import assert from "node:assert/strict";

export async function exerciseProviderDrafts(cdp, { check, until, label }) {
  const click = async (selector) => {
    await until(
      () =>
        cdp.evaluate(`(() => {
      const item=document.querySelector(${JSON.stringify(selector)});
      if(!item || item.disabled) return false;
      item.scrollIntoView({block:'center'});
      item.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));
      item.click(); return true;
    })()`),
      `click ${selector}`,
    );
  };
  const clickText = async (pattern, scope = "button") => {
    await until(
      () =>
        cdp.evaluate(`(() => {
      const item=[...document.querySelectorAll(${JSON.stringify(scope)})]
        .find(element => new RegExp(${JSON.stringify(pattern)}).test(element.textContent.trim()));
      if(!item || item.disabled)return false;
      item.click();return true;
    })()`),
      `click ${pattern}`,
    );
  };
  const input = async (selector, text) => {
    await click(selector);
    await cdp.evaluate(
      `document.querySelector(${JSON.stringify(selector)}).select()`,
    );
    await cdp.send("Input.insertText", { text });
    await until(
      () =>
        cdp.evaluate(
          `document.querySelector(${JSON.stringify(selector)})?.value === ${JSON.stringify(text)}`,
        ),
      "retain entered draft",
    );
  };
  const value = (selector) =>
    cdp.evaluate(`document.querySelector(${JSON.stringify(selector)})?.value`);
  const back = () =>
    cdp.evaluate(
      `document.querySelector('form#provider-form')?.closest('div.fixed.inset-0')?.querySelector('button:has(svg.lucide-arrow-left)')?.click()`,
    );
  const leave = async () => {
    await back();
    await clickText("^(Discard changes|放弃修改)$", '[role="dialog"] button');
    await until(
      () => cdp.evaluate("!document.getElementById('provider-form')"),
      "discard the in-memory draft",
    );
  };
  const showList = async (app) => {
    await until(
      () =>
        cdp.evaluate(`(() => {
      if(document.querySelector('button[title="Add New Provider"],button[title="添加供应商"]'))return true;
      [...document.querySelectorAll('button:has(svg.lucide-arrow-left)')].at(-1)?.click();return false;
    })()`),
      "show provider list",
    );
    await click(
      `button[title="${app === "claude" ? "Claude Code" : "Codex"}"]`,
    );
  };
  const openAdd = async () => {
    await click('button[title="Add New Provider"],button[title="添加供应商"]');
    await until(
      () =>
        cdp.evaluate(
          "!!document.querySelector('#provider-form input[name=name]')",
        ),
      "new provider form",
    );
  };
  for (const app of ["claude", "codex"]) {
    await showList(app);
    await openAdd();
    await back();
    await until(
      () => cdp.evaluate("!document.getElementById('provider-form')"),
      "pristine form closes directly",
    );
    check(
      `${label} ${app} untouched provider form closes without discard prompt`,
    );
    await openAdd();
    const keySelector = app === "claude" ? "#apiKey" : "#codexApiKey";
    const urlSelector = app === "claude" ? "#baseUrl" : "#codexBaseUrl";
    await input('#provider-form input[name="name"]', `CI unsaved ${app}`);
    await input(keySelector, `fake-draft-${app}-key`);
    await input(urlSelector, "http://127.0.0.1:9/v1");
    await click('[data-testid="shared-channel-tab"]');
    await until(
      () =>
        cdp.evaluate(
          "document.querySelector('[role=tabpanel][data-state=inactive] #provider-form') !== null",
        ),
      "ordinary draft remains mounted while shared tab is visible",
    );
    await click('[role=tab][id$="-trigger-app-specific"]');
    assert.equal(await value(keySelector), `fake-draft-${app}-key`);
    assert.equal(await value(urlSelector), "http://127.0.0.1:9/v1");
    assert.equal(
      await value('#provider-form input[name="name"]'),
      `CI unsaved ${app}`,
    );
    check(
      `${label} ${app} shared tab roundtrip retains name credential and endpoint draft`,
    );
    await back();
    await until(
      () => cdp.evaluate("!!document.querySelector('[role=dialog]')"),
      "render discard confirmation",
    );
    await cdp.screenshot(
      `${label.replaceAll(" ", "-")}-${app}-draft-confirm.png`,
    );
    await clickText("^(Keep editing|继续编辑)$", '[role="dialog"] button');
    assert.equal(await value(keySelector), `fake-draft-${app}-key`);
    await cdp.evaluate(
      "document.activeElement?.blur(); window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))",
    );
    await clickText("^(Keep editing|继续编辑)$", '[role="dialog"] button');
    assert.equal(
      await value('#provider-form input[name="name"]'),
      `CI unsaved ${app}`,
    );
    check(
      `${label} ${app} back and Escape preserve draft when continuing editing`,
    );
    await leave();
    await openAdd();
    assert.equal(await value('#provider-form input[name="name"]'), "");
    assert.equal(await value(keySelector), "");
    await back();
    await until(
      () => cdp.evaluate("!document.getElementById('provider-form')"),
      "fresh empty session closes",
    );
    check(
      `${label} ${app} explicit discard clears the next session without saving`,
    );
  }

  const id = "yunswitch-ci-provider-draft";
  const name = "CI draft editor";
  const previous = await cdp.invoke("get_current_provider", { app: "codex" });
  const fixture = {
    id,
    name,
    category: "custom",
    settingsConfig: {
      auth: { OPENAI_API_KEY: "fake-draft-edit-key" },
      config:
        'model_provider = "synthetic"\nmodel = "stored-draft-model"\n[model_providers.synthetic]\nname = "Synthetic"\nbase_url = "http://127.0.0.1:9/v1"\nwire_api = "responses"\n',
    },
    meta: { requestBudget: { recoveryTimeoutSecs: 5 } },
  };
  let added = false;
  let storedConfig;
  try {
    await cdp.invoke("add_provider", {
      app: "codex",
      provider: fixture,
      addToLive: false,
    });
    added = true;
    await cdp.invoke("switch_provider", { app: "codex", id });
    storedConfig = (await cdp.invoke("get_providers", { app: "codex" }))[id]
      .settingsConfig.config;
    await cdp.evaluate("location.reload()");
    await showList("codex");
    await until(
      () =>
        cdp.evaluate(
          `[...document.querySelectorAll('h3')].some(x=>x.textContent===${JSON.stringify(name)})`,
        ),
      "load edit fixture",
    );
    await cdp.evaluate(`(() => {
      const original=window.fetch;
      const reply=(value,ok=true)=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json','Tauri-Response':ok?'ok':'error'}});
      window.__draftProbe={original,livePending:false,saveCalls:0};
      window.fetch=function(input,...rest){
        const url=new URL(typeof input==='string'?input:input.url);
        if(url.hostname==='ipc.localhost' && url.pathname==='/read_live_provider_settings'){
          window.__draftProbe.livePending=true;
          return new Promise(resolve=>{window.__draftProbe.releaseLive=()=>resolve(reply({auth:{OPENAI_API_KEY:'fake-late-key'},config:'model = "late-model"'}));});
        }
        if(url.hostname==='ipc.localhost' && url.pathname==='/update_provider'){
          window.__draftProbe.saveCalls++;
          if(window.__draftProbe.saveCalls===1)return Promise.resolve(reply('synthetic-save-rejection',false));
          return new Promise((resolve,reject)=>{window.__draftProbe.releaseSave=()=>original.call(this,input,...rest).then(resolve,reject);});
        }
        return original.call(this,input,...rest);
      };
    })()`);
    await cdp.evaluate(`(() => {
      let card=[...document.querySelectorAll('h3')].find(x=>x.textContent===${JSON.stringify(name)});
      while(card&&!card.querySelector('button[title="Edit"],button[title="编辑"]'))card=card.parentElement;
      card?.querySelector('button[title="Edit"],button[title="编辑"]')?.click();
    })()`);
    await until(
      () =>
        cdp.evaluate(
          "window.__draftProbe.livePending && !!document.querySelector('[data-testid=provider-edit-loading]')",
        ),
      "wait for live initialization before editing",
    );
    assert.equal(
      await cdp.evaluate("!!document.getElementById('provider-form')"),
      false,
    );
    await clickText(
      "^(Use saved configuration|Continue with saved configuration|使用已保存配置继续)$",
    );
    await input("#codexDefaultModel", "edited-draft-model");
    await input('[data-request-budget="recoveryTimeoutSecs"]', "9");
    await cdp.evaluate("window.__draftProbe.releaseLive()");
    assert.equal(await value("#codexDefaultModel"), "edited-draft-model");
    assert.equal(
      await value('[data-request-budget="recoveryTimeoutSecs"]'),
      "9",
    );
    check(
      `${label} late live configuration cannot replace a manually continued edit session`,
    );
    await click('button[type="submit"][form="provider-form"]');
    await until(
      () =>
        cdp.evaluate(
          "window.__draftProbe.saveCalls===1 && !document.querySelector('button[type=submit][form=provider-form]').disabled",
        ),
      "failed save leaves editable draft",
    );
    assert.equal(await value("#codexDefaultModel"), "edited-draft-model");
    assert.equal(
      await value('[data-request-budget="recoveryTimeoutSecs"]'),
      "9",
    );
    assert.equal(
      (await cdp.invoke("get_providers", { app: "codex" }))[id].settingsConfig
        .config,
      storedConfig,
    );
    check(`${label} rejected save retains model and advanced budget for retry`);
    await click('button[type="submit"][form="provider-form"]');
    await until(
      () => cdp.evaluate("window.__draftProbe.saveCalls===2"),
      "hold retry while saving",
    );
    await back();
    await cdp.evaluate(
      "document.activeElement?.blur(); window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))",
    );
    assert.equal(
      await cdp.evaluate("!!document.getElementById('provider-form')"),
      true,
    );
    assert.equal(
      await cdp.evaluate(
        "document.querySelector('button[type=submit][form=provider-form]').disabled",
      ),
      true,
    );
    await cdp.evaluate("window.__draftProbe.releaseSave()");
    await until(
      () => cdp.evaluate("!document.getElementById('provider-form')"),
      "successful retry closes the same edit session",
    );
    const saved = (await cdp.invoke("get_providers", { app: "codex" }))[id];
    assert.match(saved.settingsConfig.config, /edited-draft-model/);
    assert.equal(saved.meta.requestBudget.recoveryTimeoutSecs, 9);
    check(
      `${label} pending save blocks dismissal and successful retry persists the retained draft`,
    );
    await cdp.screenshot(
      `${label.replaceAll(" ", "-")}-provider-draft-saved.png`,
    );
  } finally {
    await cdp
      .evaluate(
        "if(window.__draftProbe){window.fetch=window.__draftProbe.original;delete window.__draftProbe}",
      )
      .catch(() => {});
    if (previous)
      await cdp.invoke("switch_provider", { app: "codex", id: previous });
    if (added) await cdp.invoke("delete_provider", { app: "codex", id });
  }
}
