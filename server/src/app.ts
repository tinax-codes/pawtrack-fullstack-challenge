import Fastify from 'fastify';
import cors from '@fastify/cors';
import { authMiddleware } from './middleware/auth.js';
import { bookingRoutes } from './routes/bookings.js';
import { petRoutes } from './routes/pets.js';

export function buildApp() {
  const app = Fastify({ logger: false });

  app.register(cors, {
    origin: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'X-Tenant-Id', 'X-User-Id', 'X-User-Role'],
  });

  app.addHook('onRequest', async (request, reply) => {
    if (request.url.startsWith('/api/')) {
      await authMiddleware(request, reply);
    }
  });

  app.get('/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  bookingRoutes(app);
  petRoutes(app);

  return app;
}
