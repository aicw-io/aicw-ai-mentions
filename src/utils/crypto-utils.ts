import * as crypto from 'crypto';
import { homedir, hostname, platform } from 'os';

interface EncryptedData {
  data: string;
  iv: string;
  tag: string;
}

interface CredentialsFile {
  version: string;
  encrypted: boolean;
  credentials: Record<string, EncryptedData>;
}

/**
 * Derives a machine-specific encryption key
 * Uses system information to create a consistent key per machine
 */
function getMachineKey(): Buffer {
  const machineData = homedir() + platform() + hostname();
  return crypto.createHash('sha256').update(machineData).digest();
}

/**
 * Encrypts an API key using AES-256-GCM
 */
export function encryptApiKey(plainText: string): EncryptedData {
  const key = getMachineKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  let encrypted = cipher.update(plainText, 'utf8', 'base64');
  encrypted += cipher.final('base64');

  const authTag = cipher.getAuthTag();

  return {
    data: encrypted,
    iv: iv.toString('base64'),
    tag: authTag.toString('base64')
  };
}

/**
 * Decrypts an API key using AES-256-GCM
 */
export function decryptApiKey(encryptedData: EncryptedData): string {
  const key = getMachineKey();
  const iv = Buffer.from(encryptedData.iv, 'base64');
  const authTag = Buffer.from(encryptedData.tag, 'base64');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encryptedData.data, 'base64', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

/**
 * Creates a credentials file structure with encrypted API keys
 */
export function createCredentialsFile(apiKeys: Record<string, string>): CredentialsFile {
  const credentials: Record<string, EncryptedData> = {};

  for (const [key, value] of Object.entries(apiKeys)) {
    credentials[key] = encryptApiKey(value);
  }

  return {
    version: '1.0',
    encrypted: true,
    credentials
  };
}

/**
 * Decrypts all credentials from a credentials file
 */
export function decryptCredentialsFile(credFile: CredentialsFile): Record<string, string> {
  const apiKeys: Record<string, string> = {};

  for (const [key, encryptedData] of Object.entries(credFile.credentials)) {
    try {
      apiKeys[key] = decryptApiKey(encryptedData);
    } catch {
      // Callers report a user-facing warning with the credentials file path.
    }
  }

  return apiKeys;
}

/**
 * Checks if a file content is an encrypted credentials file
 */
export function isEncryptedCredentials(content: any): content is CredentialsFile {
  return content &&
    typeof content === 'object' &&
    content.encrypted === true &&
    content.version &&
    content.credentials &&
    typeof content.credentials === 'object';
}
