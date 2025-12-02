import { Container, getContainer } from '../../../src/index.js';

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
  sleepAfter = '10m';

  constructor(ctx: any, env: Env) {
    super(ctx, env);

    this.envVars = {
      AWS_ACCESS_KEY_ID: env.AWS_ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY: env.AWS_SECRET_ACCESS_KEY,
      BUCKET_NAME: env.R2_BUCKET_NAME,
      BUCKET_PREFIX: env.R2_BUCKET_PREFIX,
      R2_ACCOUNT_ID: env.R2_ACCOUNT_ID,
    };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const container = getContainer(env.FUSEDemo);
    return container.fetch(request);
  },
};
