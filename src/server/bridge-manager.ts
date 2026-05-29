/**
 * Stub for bridge-manager.ts to prevent crashes since it was deleted
 * without removing its imports.
 */

export function isBridgeConnected(userId: number): boolean {
    return false;
}

export async function sendToBridge(userId: number, type: string, payload: any, timeout?: number): Promise<any> {
    throw new Error('Bridge is deprecated and has been removed.');
}
