import { Client, LocalAuth } from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';

let clientInstance: Client | null = null;
let shuttingDown = false;

function isTargetClosed(err: unknown): boolean {
  const e = err as { name?: string; message?: string } | undefined;
  return e?.name === 'TargetCloseError' ||
    /Target closed|Session closed|browser has disconnected/i.test(e?.message ?? '');
}

// whatsapp-web.js re-injects its scripts from an un-awaited 'framenavigated'
// handler whenever WhatsApp Web reloads. If Chrome closes meanwhile, that
// rejection is unhandled and would crash Node with a raw stack trace.
process.on('unhandledRejection', (err) => {
  if (isTargetClosed(err)) {
    if (shuttingDown) return; // expected while destroying the client
    process.stderr.write('The WhatsApp browser closed unexpectedly. Try again; if it persists, run "wha reset".\n');
  } else {
    process.stderr.write(`${(err as Error)?.stack ?? err}\n`);
  }
  process.exit(1);
});

export async function getClient(): Promise<Client> {
  if (clientInstance) return clientInstance;

  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: '.wwebjs_auth' }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    },
  });

  client.on('qr', (qr) => {
    process.stderr.write('\nScan this QR code with your WhatsApp app:\n\n');
    qrcode.generate(qr, { small: true }, (output: string) => {
      process.stderr.write(output + '\n');
    });
  });

  client.on('authenticated', () => {
    process.stderr.write('Authenticated.\n');
  });

  client.on('auth_failure', (msg) => {
    process.stderr.write(`Authentication failed: ${msg}\n`);
    process.exit(1);
  });

  await new Promise<void>((resolve, reject) => {
    client.on('ready', () => {
      process.stderr.write('WhatsApp client ready.\n');
      // WhatsApp's internal chat store keeps loading after 'ready' fires.
      // A short buffer prevents getChats() from hanging on the first call.
      setTimeout(resolve, 1000);
    });
    client.on('auth_failure', reject);
    client.initialize().catch(reject);
  });

  clientInstance = client;
  return client;
}

export async function destroyClient(): Promise<void> {
  if (clientInstance) {
    shuttingDown = true;
    try {
      // Cap destroy() so a hung Puppeteer never blocks process.exit().
      await Promise.race([
        clientInstance.destroy(),
        new Promise<void>((resolve) => setTimeout(resolve, 5000)),
      ]);
    } catch {
      // TargetCloseError / "process not found" are expected when Chrome is
      // already shutting down — safe to ignore.
    }
    clientInstance = null;
  }
}
