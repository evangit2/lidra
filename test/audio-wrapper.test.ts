import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import net from "node:net";
import {
  WrapperService,
  expandCommand,
  probeTcp,
  retargetCommand,
} from "../src/audio/wrapper/service";

vi.mock("electron-log/main", () => {
  const scope = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { default: { scope: () => scope, info: vi.fn(), warn: vi.fn(), error: vi.fn() } };
});

/** A child process stand-in that records signals. */
function fakeChild(pid = 4242) {
  const child = Object.assign(new EventEmitter(), {
    pid,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    killed: false,
    kill: vi.fn(function (this: { killed: boolean }) {
      this.killed = true;
      return true;
    }),
  });
  return child;
}

function service(overrides: Partial<ConstructorParameters<typeof WrapperService>[0]> = {}) {
  const child = fakeChild();
  const spawnImpl = vi.fn(() => child) as unknown as typeof import("node:child_process").spawn;
  const instance = new WrapperService({
    command: "~/.lidra-wrapper/wrapper -D 10020 -M 20020",
    decryptor: "127.0.0.1:10020",
    manifest: "127.0.0.1:20020",
    spawnImpl,
    probe: async () => true,
    portScan: false,
    ...overrides,
  });
  return { instance, child, spawnImpl };
}

describe("wrapper command expansion", () => {
  it("expands a leading ~ and $HOME", () => {
    expect(expandCommand("~/w -D 10020", "/home/evan")).toBe("/home/evan/w -D 10020");
    expect(expandCommand("$HOME/w", "/home/evan")).toBe("/home/evan/w");
    expect(expandCommand("/opt/w -M 20020", "/home/evan")).toBe("/opt/w -M 20020");
    // Only a leading ~ is a home reference, not one inside an argument.
    expect(expandCommand("/opt/w --base=~x", "/home/evan")).toBe("/opt/w --base=~x");
  });
});

describe("TCP probe", () => {
  it("sees an open socket and a closed one", async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;
    expect(await probeTcp(`127.0.0.1:${port}`)).toBe(true);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await probeTcp(`127.0.0.1:${port}`)).toBe(false);
    expect(await probeTcp("nonsense")).toBe(false);
  });
});

describe("wrapper supervision", () => {
  it("starts the command and reports running once the socket answers", async () => {
    const { instance, spawnImpl, child } = service();
    const status = await instance.start();
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(status.state).toBe("running");
    expect(status.pid).toBe(child.pid);
    expect(status.decryptor).toBe("127.0.0.1:10020");
  });

  it("reports an error when nothing ever listens", async () => {
    const { instance } = service({ probe: async () => false, startTimeoutMs: 600 });
    const status = await instance.start();
    expect(status.state).toBe("error");
    expect(status.detail).toContain("no socket");
  });

  it("refuses to start without a command", async () => {
    const { instance, spawnImpl } = service({ command: "   " });
    const status = await instance.start();
    expect(status.state).toBe("error");
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("stops the child it owns and reports stopped", async () => {
    const { instance, child } = service();
    await instance.start();
    instance.stop();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(instance.status().state).toBe("stopped");
    expect(instance.status().pid).toBeNull();
  });

  it("records a crash as an error rather than pretending it is running", async () => {
    const { instance, child } = service();
    await instance.start();
    child.emit("exit", 1, null);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const status = instance.status();
    expect(status.state).toBe("error");
    expect(status.detail).toContain("exited");
  });

  it("surfaces the latest output line for diagnostics", async () => {
    const { instance, child } = service();
    await instance.start();
    child.stderr?.emit("data", Buffer.from("FairPlayGetSubscriptionStatus: invalid list\n"));
    expect(instance.status().detail).toContain("FairPlayGetSubscriptionStatus");
  });
});

describe("port pair selection", () => {
  it("retargets -D and -M in a command line", () => {
    const command = "cd /opt/w && sudo -n ./wrapper -H 127.0.0.1 -D 10020 -M 20020 -L 'a:b' -F";
    expect(retargetCommand(command, 10021, 20021)).toBe(
      "cd /opt/w && sudo -n ./wrapper -H 127.0.0.1 -D 10021 -M 20021 -L 'a:b' -F",
    );
  });

  it("moves to a free pair when the manifest port is taken", async () => {
    // Occupy only the manifest side: a listener on the decrypt port is treated
    // as an adoptable wrapper, but a half-taken pair means a real conflict.
    const probe = net.createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const manifestPort = (probe.address() as net.AddressInfo).port;
    const port = manifestPort - 10_000;
    const child = fakeChild();
    const spawnImpl = vi.fn(() => child) as unknown as typeof import("node:child_process").spawn;
    const instance = new WrapperService({
      command: `~/.lidra-wrapper/wrapper -D ${port} -M ${manifestPort}`,
      decryptor: `127.0.0.1:${port}`,
      manifest: `127.0.0.1:${manifestPort}`,
      spawnImpl,
      probe: async () => true,
      startTimeoutMs: 600,
    });
    const status = await instance.start();
    expect(status.decryptor).toBe(`127.0.0.1:${port + 1}`);
    expect(String(spawnImpl.mock.calls[0][0])).toContain(`-D ${port + 1}`);
    await new Promise<void>((resolve) => probe.close(() => resolve()));
  });
});

describe("adoption", () => {
  it("uses a wrapper that an earlier run left running", async () => {
    const listener = net.createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    const port = (listener.address() as net.AddressInfo).port;
    const child = fakeChild();
    const spawnImpl = vi.fn(() => child) as unknown as typeof import("node:child_process").spawn;
    const instance = new WrapperService({
      command: `~/.lidra-wrapper/wrapper -D ${port} -M ${port + 10_000}`,
      decryptor: `127.0.0.1:${port}`,
      manifest: `127.0.0.1:${port + 10_000}`,
      spawnImpl,
      probe: async () => true,
      startTimeoutMs: 600,
    });
    const status = await instance.start();
    expect(status.state).toBe("running");
    expect(status.decryptor).toBe(`127.0.0.1:${port}`);
    expect(spawnImpl).not.toHaveBeenCalled();
    await new Promise<void>((resolve) => listener.close(() => resolve()));
  });
});
