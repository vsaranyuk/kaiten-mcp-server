import { PerformanceMetrics } from './types.js';

export interface AggregatedMetrics {
  tool: string;
  count: number;
  total_latency_ms: number;
  avg_latency_ms: number;
  min_latency_ms: number;
  max_latency_ms: number;
  success_rate: number;
  cache_hit_rate: number;
  errors: number;
}

export class MetricsCollector {
  private enabled: boolean;
  private metrics: PerformanceMetrics[] = [];
  private maxMetrics = 10000; // Keep last 10k metrics in memory

  constructor(enabled: boolean) {
    this.enabled = enabled;
  }

  record(metric: PerformanceMetrics): void {
    if (!this.enabled) return;

    this.metrics.push({
      ...metric,
      timestamp: metric.timestamp || new Date().toISOString(),
    });

    // Cleanup old metrics
    if (this.metrics.length > this.maxMetrics) {
      this.metrics = this.metrics.slice(-this.maxMetrics);
    }
  }

  getMetrics(): {
    total_requests: number;
    aggregated: AggregatedMetrics[];
    recent: PerformanceMetrics[];
  } {
    if (!this.enabled) {
      return { total_requests: 0, aggregated: [], recent: [] };
    }

    const aggregated = this.aggregateByTool();
    const recent = this.metrics.slice(-100); // Last 100

    return {
      total_requests: this.metrics.length,
      aggregated,
      recent,
    };
  }

  private aggregateByTool(): AggregatedMetrics[] {
    const grouped = new Map<string, PerformanceMetrics[]>();

    // Group by tool
    for (const metric of this.metrics) {
      if (!grouped.has(metric.tool)) {
        grouped.set(metric.tool, []);
      }
      grouped.get(metric.tool)!.push(metric);
    }

    // Aggregate each tool
    const result: AggregatedMetrics[] = [];

    for (const [tool, metrics] of grouped.entries()) {
      const latencies = metrics.map((m) => m.latency_ms);
      const successes = metrics.filter((m) => m.success).length;
      const cacheHits = metrics.filter((m) => m.cache_hit === true).length;
      const errors = metrics.filter((m) => !m.success).length;

      result.push({
        tool,
        count: metrics.length,
        total_latency_ms: latencies.reduce((a, b) => a + b, 0),
        avg_latency_ms: Math.round(latencies.reduce((a, b) => a + b, 0) / metrics.length),
        min_latency_ms: Math.min(...latencies),
        max_latency_ms: Math.max(...latencies),
        success_rate: Math.round((successes / metrics.length) * 100),
        cache_hit_rate: Math.round((cacheHits / metrics.length) * 100),
        errors,
      });
    }

    // Sort by count (most used first)
    return result.sort((a, b) => b.count - a.count);
  }

  clear(): void {
    this.metrics = [];
  }

  exportCSV(): string {
    if (!this.enabled || this.metrics.length === 0) {
      return 'No metrics to export';
    }

    const headers = 'tool,timestamp,latency_ms,success,cache_hit,queue_wait_ms,error';
    const rows = this.metrics.map((m) =>
      [
        m.tool,
        m.timestamp,
        m.latency_ms,
        m.success,
        m.cache_hit ?? '',
        m.queue_wait_ms ?? '',
        m.error ?? '',
      ].join(',')
    );

    return [headers, ...rows].join('\n');
  }
}
