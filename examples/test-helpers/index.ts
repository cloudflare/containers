import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

export interface WranglerDevOptions {
  cwd?: string;
  timeout?: number;
  env?: typeof process.env;
}

export class WranglerDevRunner {
  private process: ChildProcessWithoutNullStreams;
  private stdout: string = '';
  private stderr: string = '';
  private url: string | null = null;
  private readonly timeout: number;
  private urlPromise: Promise<string>;

  constructor(private options: WranglerDevOptions = {}) {
    this.timeout = options.timeout || 30000;

    this.process = spawn('npx', ['wrangler', 'dev'], {
      cwd: this.options.cwd,
      env: this.options.env || process.env,
      stdio: 'pipe',
    });

    this.urlPromise = new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error(`Timeout after ${this.timeout}ms waiting for wrangler dev to be ready`));
      }, this.timeout);

      this.process.stdout.on('data', (data: Buffer) => {
        const output = data.toString();
        this.stdout += output;
        console.log(output);

        // Check for ready pattern
        const match = output.match(/Ready on (?<url>https?:\/\/.*)/);
        if (match && match.groups?.url && !this.url) {
          this.url = match.groups.url;
          clearTimeout(timeoutId);
          resolve(this.url);
        }
      });

      this.process.stderr.on('data', (data: Buffer) => {
        this.stderr += data.toString();
        console.log(data.toString());
      });
    });
  }

  getStdout(): string {
    return this.stdout;
  }

  getStderr(): string {
    return this.stderr;
  }

  async getUrl(): Promise<string> {
    return this.urlPromise;
  }

  async stop(containerId?: string[]): Promise<void> {
    for (const id of containerId ?? []) {
      await fetch(this.url + '/stop?id=' + id);
    }
    // give it a second to run the onStop hook before we kill the process
    await new Promise(resolve => setTimeout(resolve, 1000));
    this.process.kill('SIGTERM');

    // Wait a bit for the process to finish
    return new Promise<void>(resolve => {
      this.process.on('close', () => resolve());
      // Fallback timeout
      setTimeout(resolve, 1000);
    });
  }
}

export const fetchWithAccess = async (url: string, options: RequestInit = {}) => {
  const accessClientId = process.env.ACCESS_CLIENT_ID;
  const accessClientSecret = process.env.ACCESS_SECRET;

  if (!accessClientId || !accessClientSecret) {
    throw new Error(
      'CF-Access-Client-Id and CF-Access-Client-Secret must be set in environment variables'
    );
  }

  const headers = new Headers(options.headers || {});
  headers.set('CF-Access-Client-Id', accessClientId);
  headers.set('CF-Access-Client-Secret', accessClientSecret);

  return await fetch(url, {
    ...options,
    headers,
  });
};
