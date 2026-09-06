import { afterEach, expect, test } from "vitest";
import http from "node:http";
import HttpTransport from "../../src/connectors/mcp/transports/http.js";

const transports = [];
afterEach(async () => { await Promise.all(transports.splice(0).map(transport => transport.stop())); });
async function setup(options = {}) {
  const transport = new HttpTransport({ port: 0, ...options });
  let calls = 0;
  transport.onMessage(async () => { calls++; });
  await transport.start();
  transports.push(transport);
  return { port: transport.port, url: transport.url, calls: () => calls };
}
function request(port, { method = "POST", path = "/message", headers = {}, setHost = true, hostname = "127.0.0.1" } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname, port, method, path, headers, setHost }, res => {
      if (res.headers["content-type"]?.startsWith("text/event-stream")) {
        res.once("data", () => { resolve({ status: res.statusCode, headers: res.headers }); req.destroy(); });
      } else {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers }));
      }
    });
    req.on("error", reject);
    req.end(method === "POST" ? JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) : undefined);
  });
}
test.each([["POST", "/message"], ["GET", "/sse"], ["OPTIONS", "/message"]])("%s rejects untrusted origins before dispatch", async (method, path) => {
  const server = await setup();
  const response = await request(server.port, { method, path, headers: { Origin: "https://evil.example", "Content-Type": "text/plain" } });
  expect(response.status).toBe(403);
  expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  expect(server.calls()).toBe(0);
});
test.each([null, "https://app.example", "*"])("origin-less native clients remain allowed with origin option %s", async allowedOrigin => {
  const server = await setup({ allowedOrigin });
  expect((await request(server.port)).status).toBe(202);
  expect(server.calls()).toBe(1);
});
test.each([["POST", "/message", 202], ["GET", "/sse", 200], ["OPTIONS", "/message", 204]])("%s accepts the configured browser origin", async (method, path, status) => {
  const server = await setup({ allowedOrigin: "https://app.example" });
  const response = await request(server.port, { method, path, headers: { Origin: "https://app.example", "Content-Type": "application/json" } });
  expect(response.status).toBe(status);
  expect(response.headers["access-control-allow-origin"]).toBe("https://app.example");
});
test.each(["https://evil.example", "http://app.example", "https://app.example:444", "https://app.example.evil", "null", ""])("exact origin rejects %s", async origin => {
  const server = await setup({ allowedOrigin: "https://app.example" });
  expect((await request(server.port, { headers: { Origin: origin } })).status).toBe(403);
  expect(server.calls()).toBe(0);
});
test.each(["null", "file:///tmp/test", "https://user@app.example", "https://app.example/path", "not-an-origin", ["https://a.example", "https://b.example"]])("wildcard rejects invalid origin %s", async origin => {
  const server = await setup({ allowedOrigin: "*" });
  expect((await request(server.port, { headers: { Origin: origin } })).status).toBe(403);
  expect(server.calls()).toBe(0);
});
test("wildcard explicitly permits a valid browser origin", async () => {
  const server = await setup({ allowedOrigin: "*" });
  const response = await request(server.port, { headers: { Origin: "https://app.example" } });
  expect(response.status).toBe(202);
  expect(response.headers["access-control-allow-origin"]).toBe("*");
});
test.each(["evil.example", "127.0.0.1.evil.example", "localhost.evil", "user@127.0.0.1", "127.0.0.1:1"])("rejects untrusted Host %s without Origin", async host => {
  const server = await setup();
  expect((await request(server.port, { headers: { Host: host } })).status).toBe(403);
  expect(server.calls()).toBe(0);
});
test("allowed Origin and forwarded headers do not bypass Host validation", async () => {
  const server = await setup({ allowedOrigin: "*" });
  const response = await request(server.port, { headers: { Host: "evil.example", Origin: "https://app.example", "X-Forwarded-Host": "localhost", "X-Forwarded-For": "127.0.0.1" } });
  expect(response.status).toBe(403);
  expect(server.calls()).toBe(0);
});
test("loopback hostname and explicit port are accepted", async () => {
  const server = await setup();
  expect((await request(server.port, { headers: { Host: "LOCALHOST:" + server.port } })).status).toBe(202);
  expect(server.calls()).toBe(1);
});
test("duplicate and missing Host headers cannot dispatch", async () => {
  const server = await setup();
  for (const options of [{ headers: ["Host", "127.0.0.1:" + server.port, "Host", "evil.example"], setHost: false }, { setHost: false }]) {
    expect([400, 403]).toContain((await request(server.port, options)).status);
  }
  expect(server.calls()).toBe(0);
});

test("IPv6 authority and advertised ephemeral URL are usable", async () => {
  const server = await setup({ host: "::1" });
  expect(server.url).toBe("http://[::1]:" + server.port);
  expect((await request(server.port, { hostname: "::1" })).status).toBe(202);
  expect(server.calls()).toBe(1);
});
test("wildcard binding accepts the actual local interface, not arbitrary DNS names", async () => {
  const server = await setup({ host: "0.0.0.0" });
  expect((await request(server.port)).status).toBe(202);
  expect((await request(server.port, { headers: { Host: "evil.example:" + server.port } })).status).toBe(403);
});