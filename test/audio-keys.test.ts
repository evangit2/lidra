import net from "node:net";
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  HttpKeyProvider,
  KeyCache,
  KeyError,
  SocketKeyProvider,
  UnconfiguredKeyProvider,
  createKeyProvider,
  parseSocketAddress,
} from "../src/audio/keys";

const KEY = Buffer.from("000102030405060708090a0b0c0d0e0f", "hex");

const openSocketService = async (
  handler: (line: string, respond: (payload: unknown) => void) => void,
): Promise<{ address: string; close: () => Promise<void>; lines: string[] }> => {
  const lines: string[] = [];
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        lines.push(line);
        handler(line, (payload) => socket.write(`${JSON.stringify(payload)}\n`));
        newline = buffer.indexOf("\n");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (typeof address !== "object" || !address) throw new Error("no address");
  return {
    address: `127.0.0.1:${address.port}`,
    lines,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

describe("key service transports", () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
  });

  it("parses addresses", () => {
    expect(parseSocketAddress("127.0.0.1:9000")).toEqual({ host: "127.0.0.1", port: 9000 });
    expect(parseSocketAddress("unix:/run/lidra.sock")).toEqual({ path: "/run/lidra.sock" });
    expect(() => parseSocketAddress("host:99999")).toThrow(KeyError);
  });

  it("resolves a key over a socket", async () => {
    const service = await openSocketService((_line, respond) => {
      respond({ key: KEY.toString("base64") });
    });
    closers.push(service.close);
    const provider = new SocketKeyProvider(service.address);
    const key = await provider.getKey({ adamId: "1440833098", keyUri: "skd://itunes.apple.com/x" });
    expect(key.equals(KEY)).toBe(true);
    expect(JSON.parse(service.lines[0])).toMatchObject({
      adamId: "1440833098",
      keyUri: "skd://itunes.apple.com/x",
    });
  });

  it("accepts hex keys", async () => {
    const service = await openSocketService((_line, respond) => {
      respond({ key: KEY.toString("hex") });
    });
    closers.push(service.close);
    const key = await new SocketKeyProvider(service.address).getKey({
      adamId: "1",
      keyUri: "skd://a",
    });
    expect(key.equals(KEY)).toBe(true);
  });

  it("surfaces service errors and malformed keys", async () => {
    const service = await openSocketService((line, respond) => {
      respond(line.includes("bad") ? { error: "not entitled" } : { key: "AAAA" });
    });
    closers.push(service.close);
    const provider = new SocketKeyProvider(service.address);
    await expect(provider.getKey({ adamId: "bad", keyUri: "skd://a" })).rejects.toThrow(
      /not entitled/,
    );
    await expect(provider.getKey({ adamId: "1", keyUri: "skd://a" })).rejects.toThrow(/expected 16/);
  });

  it("resolves a key over HTTP with a bearer token", async () => {
    const seen: Array<{ auth?: string; body?: string }> = [];
    const server = http.createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      request.on("end", () => {
        seen.push({ auth: request.headers.authorization, body });
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ key: KEY.toString("base64") }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address();
    if (typeof address !== "object" || !address) throw new Error("no address");

    const provider = new HttpKeyProvider(`http://127.0.0.1:${address.port}/key`, "secret");
    const key = await provider.getKey({ adamId: "42", keyUri: "skd://b" });
    expect(key.equals(KEY)).toBe(true);
    expect(seen[0].auth).toBe("Bearer secret");
    expect(JSON.parse(seen[0].body ?? "{}")).toMatchObject({ adamId: "42" });
  });

  it("fails clearly when nothing is configured", async () => {
    const provider = createKeyProvider({ transport: "socket", address: "" });
    expect(provider).toBeInstanceOf(UnconfiguredKeyProvider);
    await expect(provider.getKey({ adamId: "1", keyUri: "skd://a" })).rejects.toThrow(
      /no key source configured/,
    );
  });
});

describe("key cache", () => {
  it("asks the service once per song and key URI", async () => {
    let calls = 0;
    const service = await openSocketService((_line, respond) => {
      calls += 1;
      respond({ key: KEY.toString("base64") });
    });
    try {
      const cache = new KeyCache(new SocketKeyProvider(service.address));
      const request = { adamId: "7", keyUri: "skd://itunes.apple.com/y" };
      await cache.get(request);
      await cache.get(request);
      await cache.get({ ...request, keyUri: "skd://itunes.apple.com/z" });
      expect(calls).toBe(2);
    } finally {
      await service.close();
    }
  });

  it("rejects keys of the wrong length", async () => {
    const cache = new KeyCache({
      name: "stub",
      getKey: async () => Buffer.alloc(15),
    });
    await expect(cache.get({ adamId: "1", keyUri: "skd://a" })).rejects.toThrow(/expected 16/);
  });
});
