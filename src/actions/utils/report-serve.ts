import { createServer, IncomingMessage, ServerResponse } from 'http';
import { createConnection } from 'net';
import { readFile } from 'fs/promises';
import { extname, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { USER_DATA_DIR } from '../../config/user-paths.js';
import { generateStaticNavigation } from '../../utils/report-projects-navigation-generator.js';
import { logger } from '../../utils/compact-logger.js';
import { openInDefaultBrowser } from '../../utils/misc-utils.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = parseInt(process.env.PORT || '8080');

const MIME_TYPES: { [key: string]: string } = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};
// Check if a port is available
function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(port, 'localhost');
    socket.on('connect', () => {
      socket.destroy();
      resolve(false); // Port is busy
    });
    socket.on('error', () => {
      resolve(true); // Port is available
    });
  });
}

// Find an available port starting from the default
async function findAvailablePort(startPort: number): Promise<number> {
  for (let port = startPort; port < startPort + 10; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available ports found between ${startPort} and ${startPort + 9}`);
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  try {
    // Parse URL (PORT will be set dynamically)
    const url = new URL(req.url || '/', `http://localhost:8080`);
    let filePath = decodeURIComponent(url.pathname);

    // Remove leading slash and construct full path
    filePath = filePath.substring(1);

    // Try multiple locations for backward compatibility
    const possiblePaths = [
      join(USER_DATA_DIR, 'reports', filePath),
      join(__dirname, '..', 'data', filePath),
      join(process.cwd(), 'data', filePath)
    ];

    let foundPath: string | null = null;

    // First, check if any of the paths exist
    for (const path of possiblePaths) {
      if (existsSync(path)) {
        foundPath = path;
        break;
      }
    }

    if (!foundPath) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
      return;
    }

    // Handle file serving
    try {
      // If it's a directory, try to serve index.html
      const indexPath = join(foundPath, 'index.html');
      let fileToServe = foundPath;

      if (existsSync(indexPath)) {
        fileToServe = indexPath;
      }

      const data = await readFile(fileToServe);
      const ext = extname(fileToServe);
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';

      res.writeHead(200, { 'Content-Type': contentType });
      res.end(data);
    } catch (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
    }

  } catch (error: any) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('500 Internal Server Error');
  }
});

export async function startServer(): Promise<number> {
  try {
    // Generate static navigation pages before starting server
    logger.info('Generating navigation pages...');
    await generateStaticNavigation();

    const port = await findAvailablePort(DEFAULT_PORT);

    return new Promise((resolve, reject) => {
      server.listen(port, () => {
        logger.info('\n🌐 aicw-ai-mentions - AI Mentions Server');
        if (port !== DEFAULT_PORT) {
          logger.info(`⚠️  Port ${DEFAULT_PORT} was busy, using port ${port} instead`);
        }
        logger.info(`📊 Server running at http://localhost:${port}/`);
        // now try to open in default browser
        // Try to open the browser but catch errors to avoid crashing if it fails
        openInDefaultBrowser(`http://localhost:${port}/`).catch((err) => {
          logger.warn(`Could not open browser automatically: ${err?.message || err}`);
          logger.info('\nCopy-paste to browser (or CTRL+mouse click to open in your browser):');
          logger.log(`  http://localhost:${port}/`);
        });
        resolve(port);
      });

      server.on('error', (error) => {
        reject(error);
      });
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    throw error;
  }
}

export function stopServer(): void {
  server.close();
}

export function isServerRunning(): boolean {
  return server.listening;
}

export function getServerPort(): number | null {
  const addr = server.address();
  return addr && typeof addr === 'object' ? addr.port : null;
}

// If running directly (not imported)
if (import.meta.url === `file://${process.argv[1]}`) {
  startServer();
}