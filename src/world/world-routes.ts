import type { FastifyInstance } from 'fastify';
import type { WorldStateAggregator } from './world-state.js';

export function registerWorldStateRoutes(app: FastifyInstance, aggregator: WorldStateAggregator): void {
  app.get('/api/v1/world-state', async () => {
    return aggregator.get();
  });

  app.post('/api/v1/world-state/refresh', async () => {
    return aggregator.compute();
  });
}
