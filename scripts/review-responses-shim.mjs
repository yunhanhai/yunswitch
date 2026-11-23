// Fixed-snapshot review; never applies a patch or loads personal shim settings.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import http from "node:http";
import { once } from "node:events";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const source = "560176bbb74a0bceb2dc4836e70b99f33214c1b0";
const repository = process.argv[2];
if (!repository) {
  throw new Error(
    "Usage: node scripts/review-responses-shim.mjs <shim-repository>",
  );
}
const tempRoot = await realpath(tmpdir());
const fixture = await mkdtemp(path.join(tempRoot, "yunswitch-shim-review-"));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

try {
  for (const name of ["server.mjs", "retry-routing.mjs", "sanitize.mjs"]) {
    const bytes = execFileSync(
      "git",
      ["-C", repository, "show", `${source}:src-patched/${name}`],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    await writeFile(path.join(fixture, name), bytes);
  }
  await writeFile(
    path.join(fixture, "usage.mjs"),
    'export function createUsageObserver() { throw new Error("Usage observer must stay disabled in synthetic review"); }\n',
  );
  const { createShimServer } = await import(
    pathToFileURL(path.join(fixture, "server.mjs"))
  );
  const { classifyStreamText, configFromOverrides } = await import(
    pathToFileURL(path.join(fixture, "retry-routing.mjs"))
  );
  const results = [];
  async function listen(server) {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    return `http://127.0.0.1:${server.address().port}`;
  }
  async function close(server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  function ok(res) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
  }
  async function runCase(name, routeOptions, handler, exercise, options = {}) {
    let count = 0;
    const requests = [];
    const upstream = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const record = {
        body: JSON.parse(Buffer.concat(chunks).toString() || "{}"),
      };
      requests.push(record);
      await handler(req, res, ++count);
    });
    const base = await listen(upstream);
    let shim;
    try {
      const routeFile = path.join(fixture, `routes-${name}.json`);
      await writeFile(
        routeFile,
        JSON.stringify({ [name]: { upstream: base, ...routeOptions } }),
      );
      const retry = configFromOverrides(
        {},
        {
          routes: routeFile,
          "retry-429": 1,
          "retry-backoff-ms": options.backoff ?? 1,
          "retry-max-wait-ms": options.maxWait ?? 10,
          "retry-stream": true,
          "retry-stream-hold-ms": 30,
          "stream-idle-timeout-ms": 400,
        },
      );
      shim = createShimServer({
        upstreamBaseUrl: base,
        timeoutMs: options.timeout ?? 500,
        retry,
        routes: retry.routes,
        mode: "passthrough",
        logUsage: false,
        logger: () => {},
      });
      const local = await listen(shim);
      const send = (body = {}, extra = {}) =>
        fetch(`${local}/${name}/v1/responses`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer synthetic-only-fake-key",
          },
          body: JSON.stringify({
            model: "synthetic-model",
            input: "synthetic-input",
            ...body,
          }),
          signal: AbortSignal.timeout(5000),
          ...extra,
        });
      results.push({ name, ...(await exercise({ send, requests, retry })) });
    } finally {
      if (shim) await close(shim);
      await close(upstream);
    }
  }

  await runCase(
    "routebudget",
    { timeoutMs: 25, retries: 0, backoffMs: 1, maxWaitMs: 1 },
    async (_req, res) => {
      await pause(90);
      if (!res.destroyed) ok(res);
    },
    async ({ send, retry }) => {
      assert.equal(retry.routes.get("/routebudget").budget.timeoutMs, 25);
      const start = performance.now();
      const response = await send();
      await response.text();
      assert.equal(response.status, 200);
      return {
        observation: "route timeout parsed but not applied by server glue",
        configuredRouteTimeoutMs: 25,
        status: response.status,
        elapsedMs: Math.round(performance.now() - start),
      };
    },
  );

  for (const [name, route, body, status, errorBody] of [
    ["routeretry", { retries: 0 }, {}, 503, ""],
    [
      "stateful",
      {},
      { previous_response_id: "synthetic-resource-bound-id" },
      503,
      "",
    ],
    [
      "authheuristic",
      {},
      {},
      401,
      JSON.stringify({
        error: { code: "invalid_api_key", message: "Please retry later" },
      }),
    ],
  ]) {
    await runCase(
      name,
      route,
      (_req, res, count) => {
        if (count === 1) {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(errorBody);
        } else ok(res);
      },
      async ({ send, requests }) => {
        const response = await send(body);
        await response.text();
        assert.equal(response.status, 200);
        assert.equal(requests.length, 2);
        if (name === "stateful") {
          assert.ok(
            requests.every(
              (request) =>
                request.body.previous_response_id === body.previous_response_id,
            ),
          );
        }
        return { upstreamRequests: requests.length, status: response.status };
      },
    );
  }

  let cancelFirst;
  const cancelSeen = new Promise((resolve) => {
    cancelFirst = resolve;
  });
  await runCase(
    "cancelwait",
    {},
    (_req, res, count) => {
      res.writeHead(429);
      res.end();
      if (count === 1) cancelFirst();
    },
    async ({ send, requests }) => {
      const controller = new AbortController();
      const request = send({}, { signal: controller.signal }).catch(() => null);
      await cancelSeen;
      await pause(25);
      controller.abort();
      await request;
      await pause(400);
      assert.equal(requests.length, 2);
      return {
        observation: "client cancel during backoff still sends next request",
        upstreamRequests: requests.length,
      };
    },
    { backoff: 200, maxWait: 200 },
  );

  await runCase(
    "slowstream",
    {},
    async (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        'event: response.created\ndata: {"type":"response.created"}\n\n',
      );
      await pause(120);
      if (!res.destroyed) {
        res.end(
          'event: response.completed\ndata: {"type":"response.completed"}\n\n',
        );
      }
    },
    async ({ send }) => {
      const response = await send();
      assert.ok((await response.text()).includes("response.completed"));
      return {
        observation: "separate idle budget allows gaps beyond header timeout",
        status: response.status,
      };
    },
    { timeout: 50 },
  );

  const deceptiveError =
    'event: error\ndata: {"type":"error","error":{"code":"invalid_api_key","message":"capacity"}}\n\n';
  assert.equal(classifyStreamText(deceptiveError), "transient-error");
  results.push({
    name: "streamclassification",
    observation: "capacity message overrides explicit invalid_api_key code",
    classification: classifyStreamText(deceptiveError),
  });
  console.log(
    JSON.stringify(
      {
        source,
        scope:
          "Fixed tracked files; unused throwing usage stub; logUsage=false; loopback only; fake credentials. Passing assertions reproduce observed defects.",
        results,
      },
      null,
      2,
    ),
  );
} finally {
  const resolved = await realpath(fixture);
  assert.equal(path.dirname(resolved), tempRoot);
  assert.ok(path.basename(resolved).startsWith("yunswitch-shim-review-"));
  await rm(fixture, { recursive: true, force: true, maxRetries: 3 });
}
