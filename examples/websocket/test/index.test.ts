import { WranglerDevRunner } from '../../test-helpers';
import { describe } from 'vitest';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

describe('WebSocket proxy functionality', () => {
  describe('local', async () => {
    test('container.fetch() can proxy WebSocket connections', async () => {
      const runner = new WranglerDevRunner();
      const url = await runner.getUrl();
      const id = randomUUID();

      // Establish WebSocket connection via container.fetch()
      const wsUrl = url.replace('http', 'ws') + `/fetch/ws?id=${id}`;
      const ws = new WebSocket(wsUrl);

      const messages: string[] = [];

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('WebSocket connection timeout'));
        }, 10000);

        ws.on('open', () => {
          clearTimeout(timeout);
          // Send a test message
          ws.send('Hello from test');
        });

        ws.on('message', data => {
          const message = data.toString();
          messages.push(message);

          // Close after receiving echo
          if (message.includes('Echo from container')) {
            ws.close();
            resolve();
          }
        });

        ws.on('error', error => {
          clearTimeout(timeout);
          reject(error);
        });
      });

      // Verify we received the welcome message and echo
      expect(messages).toHaveLength(2);
      expect(messages[0]).toContain('WebSocket connected to container');
      expect(messages[1]).toContain('Echo from container: Hello from test');

      await runner.destroy([id]);
    });
  });
});
