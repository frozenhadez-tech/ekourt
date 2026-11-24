import cookieParser from 'cookie-parser';
import express from 'express';
import helmet from 'helmet';
import fs from 'node:fs';
import path from 'node:path';
import { requireAuth } from './auth';
import { db } from './db';
import { env, rootDir } from './env';
import { broadcastWrites, eventsHandler } from './events';
import { errorHandler, HttpError } from './http';
import { authRouter, employeesRouter } from './routes/auth';
import {
  categoriesRouter, discountsRouter, equipmentRouter, expenseCategoriesRouter, holidaysRouter, inventoryRouter, membershipsRouter,
  plansRouter, productsRouter, ratesRouter, rentalsRouter, servicesRouter, suppliersRouter,
} from './routes/catalog';
import { playersRouter } from './routes/players';
import { dashboardRouter, reportsRouter } from './routes/reports';
import { courtsRouter, reservationsRouter } from './routes/reservations';
import { expensesRouter, shiftsRouter, transactionsRouter } from './routes/sales';
import { auditRouter, notificationsRouter, settingsRouter, uploadsRouter } from './routes/system';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet({
    contentSecurityPolicy: env.isProd ? { directives: { defaultSrc: ["'self'"], imgSrc: ["'self'", 'data:', 'blob:'], styleSrc: ["'self'", "'unsafe-inline'"], fontSrc: ["'self'", 'data:'] } } : false,
  }));
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  const api = express.Router();

  // CSRF defence in depth (on top of the SameSite=Strict session cookie): state-changing
  // requests must carry a custom header, which a cross-site form cannot send.
  api.use((req, _res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('X-Requested-With') !== 'ekourt') {
      throw new HttpError(403, 'Missing request header', 'CSRF');
    }
    next();
  });
  api.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  api.get('/health', async (_req, res) => {
    const r = await db.query(`select now() as now, current_database() as database, version() as version, to_char(now() at time zone 'Asia/Manila', 'YYYY-MM-DD HH24:MI') as manila_time`);
    res.json({ ok: true, ...r.rows[0] });
  });
  api.get('/public', async (_req, res) => {
    const r = await db.query(`select value from business_settings where key = 'business_name'`);
    res.json({ business_name: r.rows[0]?.value ?? 'E-Kourt' });
  });
  api.use('/auth', authRouter);

  // Everything below requires a valid session.
  api.use(requireAuth);
  api.use(broadcastWrites);
  api.get('/events', eventsHandler);
  api.use('/employees', employeesRouter);
  api.use('/players', playersRouter);
  api.use('/courts', courtsRouter);
  api.use('/reservations', reservationsRouter);
  api.use('/products', productsRouter);
  api.use('/product-categories', categoriesRouter);
  api.use('/suppliers', suppliersRouter);
  api.use('/services', servicesRouter);
  api.use('/court-rates', ratesRouter);
  api.use('/holidays', holidaysRouter);
  api.use('/discounts', discountsRouter);
  api.use('/expense-categories', expenseCategoriesRouter);
  api.use('/membership-plans', plansRouter);
  api.use('/memberships', membershipsRouter);
  api.use('/equipment', equipmentRouter);
  api.use('/rentals', rentalsRouter);
  api.use('/inventory', inventoryRouter);
  api.use('/transactions', transactionsRouter);
  api.use('/shifts', shiftsRouter);
  api.use('/expenses', expensesRouter);
  api.use('/dashboard', dashboardRouter);
  api.use('/reports', reportsRouter);
  api.use('/settings', settingsRouter);
  api.use('/audit-logs', auditRouter);
  api.use('/notifications', notificationsRouter);
  api.use('/uploads', uploadsRouter);
  api.use((_req, _res) => { throw new HttpError(404, 'Unknown API route'); });

  app.use('/api', api);
  // Uploaded files are private: same auth as the API.
  app.use('/uploads', requireAuth, uploadsRouter);

  // Production: serve the built React app from the same origin.
  const dist = path.join(rootDir, 'dist');
  if (fs.existsSync(path.join(dist, 'index.html'))) {
    app.use(express.static(dist, { index: false, maxAge: '1h' }));
    app.use((req, res, next) => (req.method === 'GET' ? res.sendFile(path.join(dist, 'index.html')) : next()));
  }

  app.use(errorHandler);
  return app;
}
