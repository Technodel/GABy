# SUNy Bridge

Local agent that connects your machine to the SUNy VPS server. It provides sandboxed file operations and shell execution, enabling the SUNy AI to edit code and run commands on your local projects.

## Installation

```bash
# Install globally from npm
npm install -g suny-bridge

# Or from the local package (if distributed as .tgz)
npm install -g ./suny-bridge-1.0.0.tgz
```

## Usage

### Quick Start

```bash
# Authenticate and connect
suny-bridge --token <your_jwt_token> --server wss://suny.technodel.tech
```

### Register a project directory

Before the bridge can access your project files, register the directory:

```bash
suny-bridge --register /path/to/your/project
```

This adds the path to `~/.suny/config.json` so the sandbox allows file operations there.

### CLI Options

| Option | Description |
|--------|-------------|
| `--token <JWT>` | Authentication token (from SUNy web app) |
| `--server <URL>` | WebSocket server URL (defaults to `wss://suny.technodel.tech`) |
| `--register <path>` | Register a project directory for sandbox access |

## How It Works

1. The bridge establishes a **persistent WebSocket** connection to the SUNy server.
2. The server sends commands (read/write files, run shell commands) over this connection.
3. The bridge executes them **locally** on your machine, sandboxed to registered directories only.
4. All output streams back to the server in real-time.

### Security

- **Sandboxed**: File operations are validated against registered paths — unauthorized access is blocked.
- **Command validation**: Shell commands are checked against a blocklist of dangerous operations.
- **Auto-timeout**: Long-running commands are killed after a configurable timeout (default 120s).
- **Reconnection**: Automatically reconnects with exponential backoff if the connection drops.

## Automatic Launch Integration

When you select a project in the SUNy web app, it automatically sends a `bridge:register_path` command to register your project directory.

## Building from Source

```bash
cd bridge
npm install
npm run build    # compiles to dist/
npm pack         # creates suny-bridge-1.0.0.tgz
```

## License

MIT
