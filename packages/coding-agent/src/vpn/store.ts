import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils/dirs";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";
import { isEnoent } from "@oh-my-pi/pi-utils/fs-error";
import { type VpnProfile, VpnError } from "./subscription";

export interface VpnSubscription {
	id: string;
	url: string;
	profiles: VpnProfile[];
	updatedAt: number;
	attemptedAt?: number;
	refreshFailed?: boolean;
}

export interface VpnCore {
	version: string;
	sha256: string;
}

export interface VpnState {
	version: 1;
	protected: boolean;
	connectOnLaunch: boolean;
	lastProfile?: string;
	subscriptions: VpnSubscription[];
	core?: VpnCore;
	localhost: string[];
	lan: string[];
}

export function vpnDir(): string {
	return path.join(getAgentDir(), "vpn");
}

async function openPrivateDir(dir: string): Promise<void> {
	await fs.mkdir(dir, { recursive: true, mode: 0o700 });
	const stat = await fs.lstat(dir);
	if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
		throw new VpnError("VPN storage must be an owner-only directory.");
	}
}

export async function readVpnState(): Promise<VpnState> {
	try {
		const dir = await fs.lstat(vpnDir());
		const filename = path.join(vpnDir(), "state.json");
		const file = await fs.lstat(filename);
		const uid = process.getuid?.();
		if (
			!dir.isDirectory() ||
			dir.uid !== uid ||
			dir.mode & 0o077 ||
			!file.isFile() ||
			file.uid !== uid ||
			file.mode & 0o077
		) {
			throw new VpnError("VPN storage permissions must be 0700 (directory) and 0600 (state file).");
		}
		const state: VpnState = await Bun.file(filename).json();
		if (
			state.version !== 1 ||
			typeof state.protected !== "boolean" ||
			typeof state.connectOnLaunch !== "boolean" ||
			!Array.isArray(state.subscriptions) ||
			!Array.isArray(state.localhost) ||
			!Array.isArray(state.lan)
		) {
			throw new Error();
		}
		return state;
	} catch (error) {
		if (isEnoent(error))
			return { version: 1, protected: false, connectOnLaunch: false, subscriptions: [], localhost: [], lan: [] };
		if (error instanceof VpnError) throw error;
		throw new VpnError("Could not read VPN state.");
	}
}

/** Hold the state lock across read/modify/write so simultaneous sessions cannot lose updates. */
export async function updateVpnState<T>(update: (state: VpnState) => Promise<T>): Promise<T> {
	const dir = vpnDir();
	await openPrivateDir(dir);
	const filename = path.join(dir, "state.json");
	return withFileLock(
		filename,
		async () => {
			const state = await readVpnState();
			const result = await update(state);
			const temporary = path.join(dir, `.state-${crypto.randomUUID()}`);
			try {
				await fs.writeFile(temporary, JSON.stringify(state), { mode: 0o600, flag: "wx" });
				await fs.rename(temporary, filename);
			} finally {
				await fs.rm(temporary, { force: true }).catch(() => undefined);
			}
			return result;
		},
		{ signal: AbortSignal.timeout(60_000), retries: 600 },
	);
}
