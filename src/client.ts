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
      resolve();
    });
    client.on('auth_failure', reject);
    client.initialize().catch(reject);
  });

  clientInstance = client;
  return client;
}

export async function destroyClient(): Promise<void> {
  if (clientInstance) {
    await clientInstance.destroy();
    clientInstance = null;
  }
}
