# @suny/sdk

**The official SUNy Software Development Kit.**

Build extensions, tools, and integrations for the SUNy platform.

## Installation

```bash
npm install @suny/sdk
```

## Quick Start

```ts
import { createTool, createExtension } from '@suny/sdk';

// Create a custom tool
const weatherTool = createTool({
  name: 'get_weather',
  description: 'Get the current weather for a city',
  parameters: {
    type: 'object',
    properties: {
      city: { type: 'string' },
    },
    required: ['city'],
  },
  execute: async ({ city }) => {
    const res = await fetch(`https://api.weather.com/${city}`);
    return res.json();
  },
});

// Create an extension
const myExtension = createExtension({
  manifest: {
    name: '@my-org/weather',
    displayName: 'Weather Plugin',
    version: '1.0.0',
    description: 'Weather data for SUNy',
  },
  tools: [weatherTool],
});
```

## API

### `createTool(definition)`
Define a typed tool with JSON Schema validation.

### `createExtension(extension)`
Package tools and hooks into an installable extension.

### Adapters
- `createMemoryAdapter()` — Custom memory backends
- `createAuthProvider()` — Custom authentication
- `createBillingPlugin()` — Custom billing logic

## License

MIT
