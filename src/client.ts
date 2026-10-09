import { Client, LocalAuth } from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';

let clientInstance: Client | null = null;

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

let shuttingDown = false;

// whatsapp-web.js re-injects its scripts on page navigations without awaiting
// the result; if that races with destroy() the rejection ("Target closed") is
// unhandled and would crash the process after the command already succeeded.
process.on('unhandledRejection', (err) => {
  if (shuttingDown && /Target closed|TargetCloseError|Session closed/.test(String(err))) return;
  console.error(err);
  process.exit(1);
});

export async function destroyClient(): Promise<void> {
  shuttingDown = true;
  if (clientInstance) {
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
