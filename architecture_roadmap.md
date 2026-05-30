# SUNy Architecture Roadmap

This document outlines the strategic roadmap for evolving SUNy from a pure Cloud Web App into native local environments to provide deep integration and unhindered shell execution, achieving parity with leading local agents like Cursor and Cline.

## Phase 1: SUNy Desktop App (Electron)

Wrap the existing React web UI inside an Electron shell to provide a first-class native desktop experience.

- **Objective:** Give users a downloadable application that runs locally.
- **Key Capabilities:**
  - Full, unrestricted access to the local file system without browser picker prompts.
  - Native `child_process` execution to run PowerShell/bash commands directly.
  - Background daemon capability for persistent state and file watching.
- **Implementation Approach:**
  - Scaffold an Electron main process.
  - Expose IPC (Inter-Process Communication) handlers for `readFile`, `writeFile`, and `execShellCommand`.
  - Connect the existing React frontend (currently running in browser) to the Electron IPC bridge when running in desktop mode.

## Phase 2: SUNy VS Code Extension

Package the SUNy engine and UI into a Visual Studio Code extension.

- **Objective:** Bring the SUNy agent directly into the developer's existing IDE workflow.
- **Key Capabilities:**
  - Seamless context awareness of open files, cursor positions, and IDE diagnostics.
  - Execution of commands directly in the integrated VS Code terminal.
  - Inline diffs and code suggestions within the editor window.
- **Implementation Approach:**
  - Build a VS Code webview panel to host the SUNy React UI.
  - Use VS Code Extension APIs to handle file operations and terminal execution.
  - Proxy AI requests to the SUNy cloud backend while maintaining secure local context.

## Current Mitigations

Until the desktop app and VS Code extension are released, the following constraints remain:
- **Web App Security Constraints:** The browser cannot natively execute shell commands.
- **Legacy Bridge Removal:** The unstable local bridge service has been completely removed to stabilize the cloud environment.
- **UI Update:** The terminal button in the web UI has been disabled with an alert indicating that shell execution will be unlocked in the upcoming Desktop and VS Code versions.
