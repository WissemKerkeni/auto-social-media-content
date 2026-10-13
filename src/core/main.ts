// tn-core entry point: node --import tsx src/core/main.ts
import { createServer } from './server.ts';

const { server, cfg, db } = createServer();
server.listen(cfg.port, () => {
  console.log(JSON.stringify({
    ts: new Date().toISOString(), level: 'info', msg: 'listening', service: 'tn-core', port: cfg.port,
    image_model: cfg.models.imageModel, text_model: cfg.models.textModel,
  }));
});

const stop = async (): Promise<void> => {
  server.close();
  await db.$disconnect();
  process.exit(0);
};
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
