/**
 * @typedef {{ name: string, description: string,
 *             parameters?: object,
 *             requiresApproval?: boolean,
 *             timeoutMs?: number,
 *             handler: (args: object, ctx: object) => Promise<unknown> }} ToolDef
 *
 * @typedef {{ name: string, description?: string, client: Record<string, Function> }} ConnectorDef
 */

/** Registry untuk tool & connector. Tool dinamespacesi per-plugin ("plugin.tool"). */
export class ToolRegistry {
  #tools = new Map();

  /** @param {ToolDef} tool @param {string} pluginName */
  register(tool, pluginName) {
    if (!tool || typeof tool.name !== 'string' || !/^[a-z0-9-]+$/.test(tool.name)) {
      throw new Error(`nama tool invalid: '${tool?.name}'`);
    }
    if (typeof tool.handler !== 'function') {
      throw new Error(`tool '${tool.name}' wajib punya handler function`);
    }
    const fqName = `${pluginName}.${tool.name}`;
    if (this.#tools.has(fqName)) throw new Error(`tool '${fqName}' sudah terdaftar`);
    this.#tools.set(fqName, {
      fqName,
      pluginName,
      description: tool.description || '',
      parameters: tool.parameters || { type: 'object', properties: {} },
      requiresApproval: tool.requiresApproval ?? false,
      timeoutMs: tool.timeoutMs ?? 10_000,
      handler: tool.handler,
    });
    return fqName;
  }

  get(fqName) {
    return this.#tools.get(fqName) || null;
  }

  list() {
    return [...this.#tools.values()].map(({ handler, ...meta }) => meta);
  }
}

/** Registry konektor (integrasi service luar, mirip MCP server — blueprint §5). */
export class ConnectorRegistry {
  #connectors = new Map();

  /** @param {ConnectorDef} connector @param {string} pluginName */
  register(connector, pluginName) {
    if (!connector || typeof connector.name !== 'string' || !/^[a-z0-9-]+$/.test(connector.name)) {
      throw new Error(`nama connector invalid: '${connector?.name}'`);
    }
    if (!connector.client || typeof connector.client !== 'object') {
      throw new Error(`connector '${connector.name}' wajib expose object "client"`);
    }
    const fqName = `${pluginName}.${connector.name}`;
    if (this.#connectors.has(fqName)) throw new Error(`connector '${fqName}' sudah terdaftar`);
    this.#connectors.set(fqName, {
      fqName,
      pluginName,
      description: connector.description || '',
      methods: Object.keys(connector.client),
      client: connector.client,
    });
    return fqName;
  }

  get(fqName) {
    return this.#connectors.get(fqName) || null;
  }

  list() {
    return [...this.#connectors.values()].map(({ client, ...meta }) => meta);
  }
}
