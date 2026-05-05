import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import type { VaultConfig } from "../types.js";

const VAULT_CONFIG_DIR = join(process.env.HOME || process.env.USERPROFILE || ".", ".context-mode");
const VAULT_CONFIG_PATH = join(VAULT_CONFIG_DIR, "vaults.json");

export function loadVaultConfig(): VaultConfig[] {
  if (!existsSync(VAULT_CONFIG_PATH)) return [];
  try {
    const raw = readFileSync(VAULT_CONFIG_PATH, "utf-8");
    return JSON.parse(raw) as VaultConfig[];
  } catch {
    return [];
  }
}

export function saveVaultConfig(configs: VaultConfig[]): void {
  if (!existsSync(VAULT_CONFIG_DIR)) mkdirSync(VAULT_CONFIG_DIR, { recursive: true });
  writeFileSync(VAULT_CONFIG_PATH, JSON.stringify(configs, null, 2));
}

export function addVaultConfig(config: VaultConfig): void {
  const configs = loadVaultConfig().filter(c => c.vaultPath !== config.vaultPath);
  configs.push(config);
  saveVaultConfig(configs);
}

export function removeVaultConfig(vaultPath: string): void {
  const configs = loadVaultConfig().filter(c => c.vaultPath !== vaultPath);
  saveVaultConfig(configs);
}

export function getVaultConfig(vaultPath: string): VaultConfig | null {
  return loadVaultConfig().find(c => c.vaultPath === vaultPath) || null;
}

export function listVaultConfigs(): VaultConfig[] {
  return loadVaultConfig();
}
