import { z } from 'zod';

export interface SunyTool {
  name: string;
  description: string;
  inputSchema: z.ZodType<any>;
  execute: (input: any, context: SunyContext) => Promise<string | object>;
}

export interface SunyContext {
  userId: number;
  projectId: string;
  agentSessionId: string;
  sendMessage: (msg: string) => void;
  getMemory: (key: string) => Promise<any>;
  setMemory: (key: string, value: any) => Promise<void>;
}

export class SunyExtension {
  private tools: Map<string, SunyTool> = new Map();

  constructor(public readonly name: string, public readonly version: string) {}

  registerTool(tool: SunyTool) {
    this.tools.set(tool.name, tool);
  }

  getTools(): SunyTool[] {
    return Array.from(this.tools.values());
  }
}

export function createExtension(name: string, version: string = '1.0.0') {
  return new SunyExtension(name, version);
}
