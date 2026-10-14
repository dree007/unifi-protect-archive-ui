// docker top uses ps from the daemon's host: BusyBox (DinD) and procps both support stat.
export const PROCESS_TABLE_FIELDS = "pid,ppid,stat,comm";

export interface ContainerProcess {
  pid: number;
  parentPid: number;
  state: string;
  command: string;
}

export function parseProcessTable(output: string): ContainerProcess[] {
  return output.trim().split("\n").slice(1).filter((line) => line.trim()).map((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!match) throw new Error("Unexpected docker top process table.");
    return { pid: Number(match[1]), parentPid: Number(match[2]), state: match[3], command: match[4] };
  });
}

export function isZombie(process: ContainerProcess): boolean {
  return process.state.startsWith("Z");
}
