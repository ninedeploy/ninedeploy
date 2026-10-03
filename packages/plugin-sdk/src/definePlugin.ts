import type { PluginDefinition } from './types.js';

export function definePlugin(definition: PluginDefinition): PluginDefinition {
  if (!definition) {
    throw new Error('Plugin definition cannot be null or undefined');
  }

  if (!definition.id || typeof definition.id !== 'string') {
    throw new Error('Plugin ID is required and must be a non-empty string');
  }

  const idPattern = /^[a-z0-9-_]+$/;
  if (!idPattern.test(definition.id)) {
    throw new Error(`Invalid plugin ID "${definition.id}": Plugin ID must only contain lowercase alphanumeric characters, dashes, and underscores`);
  }

  if (!definition.name || typeof definition.name !== 'string') {
    throw new Error('Plugin name is required and must be a non-empty string');
  }

  if (!definition.version || typeof definition.version !== 'string') {
    throw new Error('Plugin version is required and must be a string (e.g. 1.0.0)');
  }

  if (definition.configSchema) {
    for (const schema of definition.configSchema) {
      if (!schema.key || typeof schema.key !== 'string') {
        throw new Error(`Invalid configSchema entry in plugin "${definition.id}": key is required`);
      }
      if (!schema.label || typeof schema.label !== 'string') {
        throw new Error(`Invalid configSchema entry "${schema.key}" in plugin "${definition.id}": label is required`);
      }
    }
  }

  if (definition.menuItems) {
    for (const item of definition.menuItems) {
      if (!item.id || typeof item.id !== 'string') {
        throw new Error(`Invalid menuItem in plugin "${definition.id}": id is required`);
      }
      if (!item.slot || typeof item.slot !== 'string') {
        throw new Error(`Invalid menuItem "${item.id}" in plugin "${definition.id}": slot is required`);
      }
      if (!item.label || typeof item.label !== 'string') {
        throw new Error(`Invalid menuItem "${item.id}" in plugin "${definition.id}": label is required`);
      }
      if (!item.route || typeof item.route !== 'string') {
        throw new Error(`Invalid menuItem "${item.id}" in plugin "${definition.id}": route is required`);
      }
    }
  }

  return definition;
}
