// Configuration resolution for multiple Genesys Cloud organizations.
//
// KV configurations:
//   1. genesys-config          = Development organization
//   2. genesys-config-edcisbu  = EDCiSBU organization
//
// MCP_AUTH_TOKEN remains a shared Wrangler secret when configured.

const KV_KEY = 'genesys-config';
const KV_KEY_EDCiSBU = 'genesys-config-edcisbu';

const ORG_CONFIGS = Object.freeze({
  dev: {
    key: KV_KEY,
    label: 'Development',
  },
  edcisbu: {
    key: KV_KEY_EDCiSBU,
    label: 'EDCiSBU',
  },
});

/**
 * Returns the Genesys Cloud organizations configured in this MCP.
 */
export function listConfiguredOrgs() {
  return Object.entries(ORG_CONFIGS).map(([id, org]) => ({
    id,
    label: org.label,
  }));
}

/**
 * Normalizes the organization supplied by an MCP tool or API request.
 *
 * Supported examples:
 *   dev
 *   development
 *   edcisbu
 *   EDCiSBU
 */
function normalizeOrgId(orgId) {
  const value = String(orgId || 'dev')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

  if (value === 'dev' || value === 'development') {
    return 'dev';
  }

  if (value === 'edcisbu') {
    return 'edcisbu';
  }

  throw new Error(
    `Unknown Genesys Cloud org "${orgId}". Valid orgs are "dev" and "edcisbu".`
  );
}

/**
 * Loads the configuration for one Genesys Cloud organization.
 *
 * Existing calls to loadConfig(env) continue to use DEV.
 * New calls can use loadConfig(env, 'edcisbu').
 */
export async function loadConfig(env, orgId = 'dev') {
  const normalizedOrgId = normalizeOrgId(orgId);
  const selectedOrg = ORG_CONFIGS[normalizedOrgId];

  let stored = null;

  if (env.CONFIG) {
    try {
      stored = await env.CONFIG.get(selectedOrg.key, 'json');
    } catch {
      throw new Error(
        `Unable to read KV configuration "${selectedOrg.key}" for the ${selectedOrg.label} org.`
      );
    }
  }

  /*
   * Legacy environment credentials apply only to DEV.
   * This prevents one global environment credential from overriding
   * the separate EDCiSBU KV credentials.
   */
  const envManaged =
    normalizedOrgId === 'dev' &&
    Boolean(env.GENESYS_CLIENT_ID || env.GENESYS_CLIENT_SECRET);

  const cfg = {
    orgId: normalizedOrgId,
    orgLabel: selectedOrg.label,
    configKey: selectedOrg.key,

    clientId: envManaged
      ? env.GENESYS_CLIENT_ID || ''
      : stored?.clientId || '',

    clientSecret: envManaged
      ? env.GENESYS_CLIENT_SECRET || ''
      : stored?.clientSecret || '',

    region:
      (envManaged ? env.GENESYS_REGION : stored?.region) ||
      'mypurecloud.com',

    /*
     * MCP_AUTH_TOKEN protects the MCP itself and can be shared.
     * If it is not a Wrangler secret, the selected KV token is used.
     */
    authToken: env.MCP_AUTH_TOKEN || stored?.authToken || '',

    source: envManaged ? 'env' : stored ? 'kv' : 'none',
    hasKv: Boolean(env.CONFIG),

    // The same namespace also stores AVA lifecycle artifacts.
        kv: env.CONFIG || null,
  };

  cfg.configured = Boolean(cfg.clientId && cfg.clientSecret);

  if (!cfg.configured) {
    throw new Error(
      `Genesys Cloud credentials are missing or incomplete for the ${selectedOrg.label} org. Expected KV key: "${selectedOrg.key}".`
    );
  }

  return cfg;
}

export async function saveConfig(
  env,
  { clientId, clientSecret, region, authToken },
  orgId = 'dev'
) {
  const normalizedOrgId = normalizeOrgId(orgId);
  const selectedOrg = ORG_CONFIGS[normalizedOrgId];

  if (!env.CONFIG) {
    throw new Error('The CONFIG KV namespace binding is unavailable.');
  }

  await env.CONFIG.put(
    selectedOrg.key,
    JSON.stringify({
      clientId,
      clientSecret,
      region,
      authToken,
    })
  );
}

export function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));

  return [...bytes]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
