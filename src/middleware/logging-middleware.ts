import { AxiosInstance, AxiosError, InternalAxiosRequestConfig, AxiosResponse } from 'axios';
import { logger } from '../logging/index.js';

export function setupLoggingMiddleware(axiosInstance: AxiosInstance): void {
  // Request interceptor
  axiosInstance.interceptors.request.use(
    (config: InternalAxiosRequestConfig) => {
      // Store request start time
      (config as any).metadata = { startTime: Date.now() };

      // Log request (if enabled)
      if (process.env.KAITEN_LOG_REQUESTS === 'true') {
        logger.debug('HTTP Request', {
          method: config.method?.toUpperCase(),
          url: config.url,
          params: config.params,
        }, 'http-client');
      }

      return config;
    },
    (error: AxiosError) => {
      logger.error('HTTP Request Error', {
        message: error.message,
        code: error.code,
      }, 'http-client');
      return Promise.reject(error);
    }
  );

  // Response interceptor
  axiosInstance.interceptors.response.use(
    (response: AxiosResponse) => {
      const config = response.config as any;
      const duration = Date.now() - (config.metadata?.startTime || 0);

      // Log response (if enabled)
      if (process.env.KAITEN_LOG_REQUESTS === 'true') {
        logger.debug('HTTP Response', {
          method: config.method?.toUpperCase(),
          url: config.url,
          status: response.status,
          duration_ms: duration,
        }, 'http-client');
      }

      // Record metric
      logger.recordMetric({
        tool: 'http_request',
        latency_ms: duration,
        success: true,
        timestamp: new Date().toISOString(),
      });

      return response;
    },
    (error: AxiosError) => {
      const config = error.config as any;
      const duration = config?.metadata?.startTime
        ? Date.now() - config.metadata.startTime
        : 0;

      logger.error('HTTP Response Error', {
        method: config?.method?.toUpperCase(),
        url: config?.url,
        status: error.response?.status,
        duration_ms: duration,
        message: error.message,
      }, 'http-client');

      // Record failed metric
      logger.recordMetric({
        tool: 'http_request',
        latency_ms: duration,
        success: false,
        timestamp: new Date().toISOString(),
        error: error.message,
      });

      return Promise.reject(error);
    }
  );
}
