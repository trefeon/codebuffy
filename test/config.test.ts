import { describe, expect, it } from "bun:test";
import { loadConfig } from "../src/config";

const noFile = () => null;

describe("loadConfig", () => {
  it("applies defaults with empty env and no file", () => {
    const cfg = loadConfig({}, noFile);
    expect(cfg.port).toBe(3000);
    expect(cfg.host).toBe("127.0.0.1");
    expect(cfg.logLevel).toBe("info");
    expect(cfg.apiBase).toBe("https://copilot.tencent.com");
    expect(cfg.consoleBase).toBe("https://www.codebuddy.cn");
  });

  it("env overrides defaults", () => {
    const cfg = loadConfig({ CODEBUFFY_PORT: "8080", CODEBUFFY_LOG_LEVEL: "debug" }, noFile);
    expect(cfg.port).toBe(8080);
    expect(cfg.logLevel).toBe("debug");
  });

  it("file overrides defaults and env overrides file", () => {
    const fileJson = JSON.stringify({ port: 4000, apiBase: "https://www.codebuddy.ai" });
    const viaFile = loadConfig({}, () => fileJson);
    expect(viaFile.port).toBe(4000);
    expect(viaFile.apiBase).toBe("https://www.codebuddy.ai");
    expect(viaFile.host).toBe("127.0.0.1");

    const envWins = loadConfig({ CODEBUFFY_PORT: "5000" }, () => fileJson);
    expect(envWins.port).toBe(5000);
    expect(envWins.apiBase).toBe("https://www.codebuddy.ai");
  });

  it("rejects a non-numeric port", () => {
    expect(() => loadConfig({ CODEBUFFY_PORT: "not-a-number" }, noFile)).toThrow(/port/);
  });

  it("rejects out-of-range port", () => {
    expect(() => loadConfig({ CODEBUFFY_PORT: "70000" }, noFile)).toThrow();
  });

  it("rejects invalid log level", () => {
    expect(() => loadConfig({ CODEBUFFY_LOG_LEVEL: "chatty" }, noFile)).toThrow(/logLevel/);
  });

  it("rejects non-http(s) bases", () => {
    const fileJson = JSON.stringify({ apiBase: "ftp://copilot.tencent.com" });
    expect(() => loadConfig({}, () => fileJson)).toThrow(/apiBase/);
  });

  it("rejects malformed config.json", () => {
    expect(() => loadConfig({}, () => "{not json")).toThrow();
  });
});
