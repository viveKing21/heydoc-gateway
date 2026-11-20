import { buildLabApp } from './server.js';

const port = Number(process.env.PORT ?? 4000);
const app = buildLabApp();

app
  .listen({ port, host: '0.0.0.0' })
  .then(() => {
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: 'info',
        msg: 'mock lab listening',
        port,
        failRate: Number(process.env.LAB_FAIL_RATE ?? 0.2),
        failMode: process.env.LAB_FAIL_MODE ?? 'mixed',
      }),
    );
  })
  .catch((err) => {
    console.error(JSON.stringify({ level: 'error', msg: 'mock lab failed', error: err.message }));
    process.exit(1);
  });
