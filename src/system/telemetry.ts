import os from "node:os";

export interface GatewayHostMetrics {
  cpuUsagePercent: number;
  cpuCores: number;
  loadAvg: number[];
  memory: {
    totalBytes: number;
    freeBytes: number;
    usedBytes: number;
    usedPercent: number;
    processRssBytes: number;
  };
  uptimeSeconds: number;
}

function readCpuTotals(): { idle: number; total: number; cores: number } {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    idle += cpu.times.idle;
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
  }
  return { idle, total, cores: cpus.length || 1 };
}

export function createGatewayMetricsSampler(): () => GatewayHostMetrics {
  let prev = readCpuTotals();

  return (): GatewayHostMetrics => {
    const curr = readCpuTotals();
    const idleDelta = curr.idle - prev.idle;
    const totalDelta = curr.total - prev.total;
    prev = curr;

    const loadAvg = os.loadavg();
    let cpuUsagePercent: number;
    if (totalDelta > 0) {
      cpuUsagePercent = ((totalDelta - idleDelta) / totalDelta) * 100;
    } else {
      cpuUsagePercent = ((loadAvg[0] ?? 0) / curr.cores) * 100;
    }
    cpuUsagePercent = Math.round(Math.max(0, Math.min(100, cpuUsagePercent)) * 10) / 10;

    const totalBytes = os.totalmem();
    const freeBytes = os.freemem();
    const usedBytes = Math.max(0, totalBytes - freeBytes);
    const usedPercent = totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 1000) / 10 : 0;

    return {
      cpuUsagePercent,
      cpuCores: curr.cores,
      loadAvg: loadAvg.map((v) => Math.round(v * 100) / 100),
      memory: {
        totalBytes,
        freeBytes,
        usedBytes,
        usedPercent,
        processRssBytes: process.memoryUsage().rss
      },
      uptimeSeconds: Math.round(os.uptime())
    };
  };
}
