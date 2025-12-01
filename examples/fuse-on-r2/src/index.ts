import { Container, getContainer, getRandom } from "@cloudflare/containers";
import { Hono } from "hono";

interface Env {
  FUSEDemo: DurableObjectNamespace<FUSEDemo>;
  AWS_ACCESS_KEY_ID: string;
  AWS_SECRET_ACCESS_KEY: string;
  R2_BUCKET_NAME: string;
  R2_BUCKET_PREFIX: string;
  R2_ACCOUNT_ID: string;
}

export class FUSEDemo extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "10m";
  envVars = {
    AWS_ACCESS_KEY_ID: this.env.AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: this.env.AWS_SECRET_ACCESS_KEY,
    BUCKET_NAME: this.env.R2_BUCKET_NAME,
    BUCKET_PREFIX: this.env.R2_BUCKET_PREFIX,
    R2_ACCOUNT_ID: this.env.R2_ACCOUNT_ID,
  };
}

const app = new Hono<{
  Bindings: Env;
}>();

app.get("/", async (c) => {
  const container = getContainer(c.env.FUSEDemo);
  return await container.fetch(c.req.raw);
});

export default app;
