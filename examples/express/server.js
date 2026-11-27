import express from 'express';

const app = express();
app.disable('x-powered-by');

app.get('/', (_req, res) => {
  res.json({ starter: 'NineDeploy Express starter' });
});

// The health check the deployment waits for (.ninedeploy: run.healthcheck).
app.get('/healthz', (_req, res) => {
  res.json({ status: 'ok' });
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, '0.0.0.0', () => {
  console.log(`Listening on ${port}`);
});
