/**
 * @suny/sdk — Tool creation utilities.
 * Define typed tools that integrate with the SUNy agent loop.
 */

export interface ToolDefinition<TArgs = Record<string, unknown>, TResult = unknown> {
  /** Unique name for the tool (lowercase, no spaces) */
  name: string;
  /** Human-readable description for the AI to decide when to use it */
  description: string;
  /** JSON Schema for the parameters */
  parameters: Record<string, unknown>;
  /** The execution function */
  execute: ToolExecutor<TArgs, TResult>;
}

export type ToolExecutor<TArgs, TResult> = (args: TArgs, context: ToolContext) => Promise<TResult>;

export interface ToolContext {
  userId: number;
  sessionId: string;
  projectId?: number;
  signal?: AbortSignal;
}

type ZodSchema = {
  _def: { typeName: string };
  _type: unknown;
  parse: (data: unknown) => unknown;
  safeParse: (data: unknown) => { success: boolean; data?: unknown; error?: unknown };
};

/**
 * Create a typed tool definition. Accepts either a raw JSON schema or a Zod schema.
 *
 * @example
 * ```ts
 * const greetTool = createTool({
 *   name: 'greet_user',
 *   description: 'Greet a user by name',
 *   parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
 *   execute: async ({ name }) => `Hello, ${name}!`,
 * });
 * ```
 */
export function createTool<TArgs extends Record<string, unknown>, TResult = unknown>(
  definition: ToolDefinition<TArgs, TResult>,
): ToolDefinition<TArgs, TResult> {
  return definition;
}

/**
 * Validate args against a JSON Schema before passing to execute().
 * Returns the validated args, or throws with a clear message.
 */
export function validateArgs<TArgs>(
  args: unknown,
  schema: Record<string, unknown>,
): TArgs {
  // Basic structural validation
  if (typeof args !== 'object' || args === null) {
    throw new ToolValidationError('Arguments must be a JSON object');
  }

  const obj = args as Record<string, unknown>;
  const props = (schema as any).properties as Record<string, { type?: string }> | undefined;
  const required = (schema as any).required as string[] | undefined;

  if (required) {
    for (const key of required) {
      if (obj[key] === undefined) {
        throw new ToolValidationError(`Missing required parameter: "${key}"`);
      }
    }
  }

  if (props) {
    for (const [key, value] of Object.entries(obj)) {
      const propSchema = props[key];
      if (!propSchema) continue;
      if (propSchema.type === 'string' && typeof value !== 'string') {
        throw new ToolValidationError(`Parameter "${key}" must be a string`);
      }
      if (propSchema.type === 'number' && typeof value !== 'number') {
        throw new ToolValidationError(`Parameter "${key}" must be a number`);
      }
      if (propSchema.type === 'boolean' && typeof value !== 'boolean') {
        throw new ToolValidationError(`Parameter "${key}" must be a boolean`);
      }
      if (propSchema.type === 'array' && !Array.isArray(value)) {
        throw new ToolValidationError(`Parameter "${key}" must be an array`);
      }
    }
  }

  return args as TArgs;
}

export class ToolValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolValidationError';
  }
}
