/** Container entrypoint for `vantagepoint-api`. */
import { buildApp } from './app.js';

const dataDir = process.env.VANTAGEPOINT_DATA_DIR ?? '/var/lib/vantagepoint';
const port = Number(process.env.PORT ?? 8080);

const app = await buildApp({ dataDir, port });
await app.listen({ port, host: '0.0.0.0' });
