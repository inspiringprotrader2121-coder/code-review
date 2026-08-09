import rawSchema from '../configuration-schema.json' with { type: 'json' };

export type ConfigurationValueType =
  | 'boolean'
  | 'csv'
  | 'csv-integers'
  | 'csv-paths'
  | 'csv-URLs'
  | 'enum'
  | 'image digest'
  | 'integer'
  | 'integer-template'
  | 'number'
  | 'owner/repository'
  | 'path'
  | 'plan'
  | 'string'
  | 'URL';

export type ConfigurationRedaction = 'none' | 'path' | 'connection' | 'secret';

export interface ConfigurationVariable {
  readonly name: string;
  readonly example: string;
  readonly type: ConfigurationValueType;
  readonly range: string;
  readonly secret: boolean;
  readonly redaction: ConfigurationRedaction;
  readonly enabled?: boolean;
  readonly render?: boolean;
  readonly allowedValues?: readonly string[];
  readonly description: string;
  readonly deprecatedAliases: readonly string[];
}

export interface ConfigurationSection {
  readonly name: string;
  readonly description: string;
  readonly variables: readonly ConfigurationVariable[];
}

export interface ConfigurationSchema {
  readonly version: number;
  readonly title: string;
  readonly sections: readonly ConfigurationSection[];
}

export const configurationSchema: ConfigurationSchema = rawSchema as ConfigurationSchema;
export const configurationVariables = Object.freeze(
  configurationSchema.sections.flatMap((section) => section.variables),
);

export function isConfigurationVariableName(name: string): boolean {
  return configurationVariables.some((variable) => variable.name === name);
}

export function isConfigurationTemplateName(name: string): boolean {
  return configurationVariables.some((variable) => {
    if (!variable.name.includes('<')) return false;
    const [prefix, suffix] = variable.name.split(/<[^>]+>/, 2);
    const value = name.slice(prefix.length, suffix ? -suffix.length : undefined);
    return (
      name.startsWith(prefix) &&
      name.endsWith(suffix) &&
      (!variable.allowedValues || variable.allowedValues.includes(value))
    );
  });
}

export function validateConfigurationSchema(
  schema: ConfigurationSchema = configurationSchema,
): void {
  const names = new Set<string>();
  for (const section of schema.sections) {
    if (!section.name || !section.description || section.variables.length === 0) {
      throw new Error('configuration schema sections must have a name, description, and variables');
    }
    for (const variable of section.variables) {
      if (!/^[A-Z][A-Z0-9_]*(?:<[A-Z][A-Z0-9_]*>)?$/.test(variable.name)) {
        throw new Error(`invalid configuration variable name: ${variable.name}`);
      }
      if (names.has(variable.name))
        throw new Error(`duplicate configuration variable: ${variable.name}`);
      names.add(variable.name);
      if (!variable.type || !variable.range || !variable.description) {
        throw new Error(`configuration metadata is incomplete for ${variable.name}`);
      }
      if (
        variable.name.includes('<') &&
        (!variable.allowedValues || variable.allowedValues.length === 0)
      ) {
        throw new Error(`configuration template must bound its values: ${variable.name}`);
      }
      if (variable.secret && variable.example.trim()) {
        throw new Error(`secret configuration example must be blank: ${variable.name}`);
      }
      if (!variable.secret && variable.redaction === 'secret') {
        throw new Error(`non-secret configuration cannot use secret redaction: ${variable.name}`);
      }
    }
  }
}

validateConfigurationSchema();
