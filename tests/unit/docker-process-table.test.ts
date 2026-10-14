import { describe, expect, it } from "vitest";

import { isZombie, parseProcessTable } from "../docker/process-table.mts";

describe("daemon process tables", () => {
  it.each([
    "PID   PPID  STAT COMMAND\n  101   10   S    node\n  202  101   R    ffmpeg\n",
    "    PID    PPID STAT COMMAND\n    101      10 Ssl  MainThread\n    202     101 RLl  ffmpeg\n",
  ])("parses BusyBox and procps columns without relying on their header names", (table) => {
    const rows = parseProcessTable(table);
    expect(rows.map(({ pid, parentPid, command }) => ({ pid, parentPid, command }))).toEqual([
      { pid: 101, parentPid: 10, command: table.includes("MainThread") ? "MainThread" : "node" },
      { pid: 202, parentPid: 101, command: "ffmpeg" },
    ]);
    expect(rows.some(isZombie)).toBe(false);
  });
  it.each(["Z", "Zs", "Z+", "Zl+"])("detects zombie state %s including additional stat flags", (state) => {
    expect(parseProcessTable(`PID PPID STAT COMMAND\n202 101 ${state} ffmpeg`).some(isZombie)).toBe(true);
  });
  it("does not mistake a live child or its parent PID for a zombie", () => {
    expect(parseProcessTable("PID PPID STAT COMMAND\n202 101 Sl ffmpeg\n101 10 Ss node").some(isZombie)).toBe(false);
  });
  it("rejects malformed rows instead of silently ignoring potentially unreaped children", () => {
    expect(() => parseProcessTable("PID PPID STAT COMMAND\n202 Sl ffmpeg")).toThrow("process table");
  });
});
