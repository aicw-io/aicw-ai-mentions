import { promises as fs } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';
import { colorize, waitForEnterInInteractiveMode, writeFileAtomic } from './utils/misc-utils.js';
import { createCredentialsFile, decryptCredentialsFile, isEncryptedCredentials } from './utils/crypto-utils.js';
import { loadAllAIPresets, getAIAIPresetWithModels } from './ai-preset-manager.js';
import { ModelConfig } from './utils/model-config.js';
import { logger } from './utils/compact-logger.js';
import { USER_CONFIG_CREDENTIALS_FILE } from './config/paths.js';


const __dirname = dirname(fileURLToPath(import.meta.url));

function question(prompt: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ============================================================================
// PROVIDER CONFIGURATION (DRY Approach)
// ============================================================================

interface ProviderInfo {
  signupUrl: string;
  keysUrl: string;
  description: string;
  keyPrefix: string;
  minLength: number;
}

const PROVIDERS: Record<string, ProviderInfo> = {
  'OpenRouter': {
    signupUrl: 'https://openrouter.ai/auth/signup',
    keysUrl: 'https://openrouter.ai/keys',
    description: 'Free tier available with generous limits',
    keyPrefix: 'sk-',
    minLength: 40
  },
  'OpenAI': {
    signupUrl: 'https://platform.openai.com/signup',
    keysUrl: 'https://platform.openai.com/api-keys',
    description: 'API access with usage-based pricing',
    keyPrefix: 'sk-',
    minLength: 40
  },
  'Anthropic': {
    signupUrl: 'https://console.anthropic.com',
    keysUrl: 'https://console.anthropic.com/settings/keys',
    description: 'Claude API access',
    keyPrefix: 'sk-ant-',
    minLength: 40
  },
  'Perplexity': {
    signupUrl: 'https://www.perplexity.ai/settings/api',
    keysUrl: 'https://www.perplexity.ai/settings/api',
    description: 'Perplexity API access',
    keyPrefix: 'pplx-',
    minLength: 32
  }
};

// ============================================================================
// HELPER FUNCTIONS (DRY Approach)
// ============================================================================

/**
 * Scan all ai_presets and collect required API key environment variable names
 * Returns Map: API key env name -> array of ai_preset names that require it
 */
async function getRequiredApiKeys(): Promise<Map<string, string[]>> {
  const requiredKeys = new Map<string, string[]>();

  try {
    const ai_presets = loadAllAIPresets();

    for (const [ai_presetName, ai_preset] of ai_presets.entries()) {
      const ai_presetWithModels = getAIAIPresetWithModels(ai_presetName);
      if (!ai_presetWithModels) continue;

      // Iterate through all model type categories
      for (const modelType of Object.keys(ai_presetWithModels.modelConfigs)) {
        const models: ModelConfig[] = ai_presetWithModels.modelConfigs[modelType] || [];
        for (const model of models) {
          if (model.api_key_env) {
            const existing = requiredKeys.get(model.api_key_env) || [];
            if (!existing.includes(ai_presetName)) {
              existing.push(ai_presetName);
              requiredKeys.set(model.api_key_env, existing);
            }
          }
        }
      }
    }
  } catch (error) {
    logger.error(`Failed to scan ai_presets for API keys: ${error}`);
  }

  return requiredKeys;
}

/**
 * Detect provider name from environment key name
 */
function detectProvider(envKeyName: string): string {
  const upperKey = envKeyName.toUpperCase();

  if (upperKey.includes('OPENROUTER')) return 'OpenRouter';
  if (upperKey.includes('OPENAI')) return 'OpenAI';
  if (upperKey.includes('ANTHROPIC')) return 'Anthropic';
  if (upperKey.includes('PERPLEXITY')) return 'Perplexity';

  return 'Unknown';
}

/**
 * Get provider information
 */
function getProviderInfo(provider: string): ProviderInfo | null {
  return PROVIDERS[provider] || null;
}

/**
 * Display provider-specific instructions for getting API key
 */
function displayProviderInstructions(provider: string, envKeyName: string, ai_presetNames: string[]): void {
  const info = getProviderInfo(provider);

  if (!info) {
    console.log(`\n📋 To use models requiring ${colorize(envKeyName, 'yellow')}, you need an API key`);
    console.log(colorize('Please obtain the key from the provider and enter it below.', 'dim'));
    return;
  }

  console.log(`\n📋 To use models requiring ${colorize(envKeyName, 'yellow')}, you need a ${colorize(provider, 'bright')} API key`);
  console.log(colorize(`   Required by ai_preset(s): ${ai_presetNames.join(', ')}`, 'dim'));

  console.log(`\n${colorize(`Step 1: Sign up for ${provider}`, 'bright')}`);
  console.log(`Visit: ${colorize(info.signupUrl, 'cyan')}`);
  console.log(colorize(`(${info.description})`, 'dim'));

  console.log(`\n${colorize('Step 2: Get your API key', 'bright')}`);
  console.log(`${info.keysUrl}`);

  console.log(`\n${colorize('Step 3: Paste your API key below', 'bright')}`);
  console.log(colorize('Enter 0 to return to the main menu', 'dim'));
}

/**
 * Validate API key format based on provider
 */
function validateKeyFormat(key: string, provider: string): { isValid: boolean; message: string } {
  // Remove any whitespace
  key = key.trim();

  // Check if it's empty
  if (!key) {
    return { isValid: false, message: 'API key cannot be empty' };
  }

  // Check for common mistakes
  if (key.includes(' ')) {
    return { isValid: false, message: 'API key should not contain spaces' };
  }

  const info = getProviderInfo(provider);
  if (!info) {
    // Unknown provider - just basic validation
    if (key.length < 20) {
      return { isValid: false, message: 'API key seems too short' };
    }
    return { isValid: true, message: 'API key format looks valid' };
  }

  // Check minimum length
  if (key.length < info.minLength) {
    return {
      isValid: false,
      message: `${provider} API keys are typically at least ${info.minLength} characters`
    };
  }

  // Check prefix
  if (!key.startsWith(info.keyPrefix)) {
    return {
      isValid: false,
      message: `${provider} API keys typically start with "${info.keyPrefix}"`
    };
  }

  return { isValid: true, message: 'API key format looks valid' };
}

/**
 * Load existing credentials from environment and encrypted file
 */
async function loadExistingCredentials(): Promise<Record<string, string>> {
  const credentials: Record<string, string> = {};

  // First, check environment variables for all potential keys
  const potentialKeys = ['OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'PERPLEXITY_API_KEY'];
  for (const key of potentialKeys) {
    if (process.env[key]) {
      credentials[key] = process.env[key]!;
    }
  }

  // Then check encrypted credentials file
  try {
    const credentialsPath = USER_CONFIG_CREDENTIALS_FILE;
    const credContent = await fs.readFile(credentialsPath, 'utf8');
    const credData = JSON.parse(credContent);

    if (isEncryptedCredentials(credData)) {
      const decrypted = decryptCredentialsFile(credData);
      // Merge with env vars (env vars take precedence)
      for (const [key, value] of Object.entries(decrypted)) {
        if (!credentials[key]) {
          credentials[key] = value;
        }
      }
    }
  } catch (error) {
    // File doesn't exist or can't be read - that's okay
  }

  return credentials;
}

/**
 * Setup a single API key (check if exists, prompt, validate)
 * Returns the new key value, or null if keeping existing
 */
async function setupSingleApiKey(
  envKeyName: string,
  existingValue: string | undefined,
  ai_presetNames: string[]
): Promise<string | null> {

  if (existingValue) {
    // Key already exists
    console.log(`\n${colorize('✓', 'green')} ${colorize(envKeyName, 'cyan')} is ALREADY configured`);
    console.log(colorize(`   Required by ai_preset(s): ${ai_presetNames.join(', ')}`, 'dim'));
    const answer = await question('  Press Enter to keep existing, or type new key to update: ');

    if (answer === '') {
      // Keep existing
      return null;
    }

    // User wants to update - validate new key
    const provider = detectProvider(envKeyName);
    const validation = validateKeyFormat(answer, provider);

    if (!validation.isValid) {
      logger.error(`  ✗ ${validation.message}`);
      console.log(colorize('  Keeping existing key.', 'yellow'));
      return null;
    }

    return answer;
  }

  let apiKey = null;
  for (let i = 0; i < 999; i++) {
    // Key doesn't exist - need to get it
    const provider = detectProvider(envKeyName);
    displayProviderInstructions(provider, envKeyName, ai_presetNames);

    apiKey = await question(`\nEnter your API key for "${provider}": `);

    if(apiKey.toLowerCase() === '0') {
      return null;
    }

    // Validate
    const validation = validateKeyFormat(apiKey, provider);

    if (!validation.isValid) {
      logger.error(`\n✗ ${validation.message}`);
      console.log(colorize('Please enter a valid API key.', 'yellow'));
      //throw new Error(`Invalid API key for ${envKeyName}`);
      apiKey = null;
      continue;
    }
    break;
  }

  return apiKey;
}

/**
 * Save all credentials to encrypted file
 */
async function saveAllCredentials(credentials: Record<string, string>): Promise<void> {

  // Create encrypted credentials file
  const encryptedCreds = createCredentialsFile(credentials);

  const credentialsPath = USER_CONFIG_CREDENTIALS_FILE;
  await writeFileAtomic(credentialsPath, JSON.stringify(encryptedCreds, null, 2));

  // Set secure file permissions (readable/writable by owner only)
  await fs.chmod(credentialsPath, 0o600);

  logger.info(`\nAPI keys saved to local credentials file:\n${credentialsPath}`);
}

// ============================================================================
// MAIN FUNCTION
// ============================================================================

async function main() {
  console.log(colorize('\n🔧 aicw-ai-mentions - API Key Setup', 'bright'));
  console.log(colorize('━'.repeat(50), 'dim'));

  try {
    // 1. Scan ai_presets for required API keys
    console.log(colorize('\nScanning configured ai_presets for required API keys...', 'dim'));
    const requiredKeys = await getRequiredApiKeys();

    if (requiredKeys.size === 0) {
      logger.warn('\n⚠️  No API keys required by current ai_presets');
      console.log(colorize('\nReturning to main menu...', 'dim'));
      await waitForEnterInInteractiveMode();
      return;
    }

    console.log(`\n📋 Found ${colorize(String(requiredKeys.size), 'bright')} API key(s) required by configured ai_presets:`);
    for (const [envKeyName, ai_presetNames] of requiredKeys.entries()) {
      const provider = detectProvider(envKeyName);
      console.log(`  • ${colorize(envKeyName, 'cyan')} (${provider}) - ${colorize(ai_presetNames.join(', '), 'dim')}`);
    }

    // 2. Load existing credentials
    const existingCreds = await loadExistingCredentials();

    // 3. Setup each required key
    const updatedCreds: Record<string, string> = { ...existingCreds };
    let hasChanges = false;

    for (const [envKeyName, ai_presetNames] of requiredKeys.entries()) {
      const existingValue = existingCreds[envKeyName];

      try {
        const newValue = await setupSingleApiKey(envKeyName, existingValue, ai_presetNames);

        if (newValue !== null) {
          updatedCreds[envKeyName] = newValue;
          hasChanges = true;
        }
      } catch (error: any) {
        logger.error(`\nSkipping ${envKeyName} due to error: ${error.message}`);
        // Continue with other keys
      }
    }

    // 4. Save all credentials if there were changes
    if (hasChanges) {
      await saveAllCredentials(updatedCreds);
      logger.success('Setup complete! All API keys saved locally.');
    } else {
      logger.success('Setup complete, run it again to add new keys or change existing.');
    }

    console.log(colorize('\nReturning to main menu...', 'green'));
    await waitForEnterInInteractiveMode();

  } catch (error: any) {
    logger.error(`\n✗ Setup failed: ${error.message}`);
    console.error(error);
    process.exit(1);
  }
}

main().catch(err => {
  logger.error(err.message || err.toString());
  throw err;
  // Don't exit - let the error bubble up
});
