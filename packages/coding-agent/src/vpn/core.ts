import { CLI_BIN_NAME } from "../cli/launcher-name";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $ } from "bun";
import { type VpnProbeProxy, fetchVpnBytes, probeVpnProxy } from "./http";
import { TempDir } from "@oh-my-pi/pi-utils/temp";
import { vpnDir, type VpnCore } from "./store";
import { PROBE_URL, VpnError, type VpnProfile, type VpnRoute, xrayConfig } from "./subscription";

const PINNED_VERSION = "26.11.9";
const RELEASE = "https://github.com/XTLS/Xray-core/releases/download";
const ARCHIVES = {
	x64: { name: "Xray-linux-64.zip", sha256: "b651f7e1d9966ee2c1b1ee1bf8b52c72771824d3065dce96bbc8bcc19ed95f82" },
	arm64: {
		name: "Xray-linux-arm64-v8a.zip",
		sha256: "64ed6858982a7f5eb85d88b811089063bd4f17561f4c8f44e0f1dc8e6f6430be",
	},
};

function binaryPath(sha256: string): string {
	if (!/^[\da-f]{64}$/.test(sha256)) throw new VpnError("Invalid installed Xray digest.");
	return path.join(vpnDir(), `xray-${sha256}`);
}

export async function verifyCore(core?: VpnCore): Promise<string> {
	if (!core) throw new VpnError(`Install Xray with /vpn core install or ${CLI_BIN_NAME} vpn core install.`);
	const binary = binaryPath(core.sha256);
	try {
		const stat = await fs.lstat(binary);
		if (stat.isFile() && stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o700) {
			const hash = new Bun.CryptoHasher("sha256");
			for await (const chunk of Bun.file(binary).stream()) hash.update(chunk);
			if (hash.digest("hex") === core.sha256) return binary;
		}
	} catch {
		// Corruption, permissions, and a missing binary require the same repair.
	}
	throw new VpnError("Xray integrity check failed. Reinstall the core.");
}

export async function installCore(
	version = PINNED_VERSION,
	expected?: string,
	proxy?: VpnProbeProxy,
): Promise<VpnCore> {
	if (process.platform !== "linux" || (process.arch !== "x64" && process.arch !== "arm64")) {
		throw new VpnError("Managed VPN requires Linux x64 or arm64.");
	}
	const archive = ARCHIVES[process.arch];
	const sha256 = expected?.toLowerCase() ?? (version === PINNED_VERSION ? archive.sha256 : undefined);
	if (
		!/^\d{2}\.\d{1,2}\.\d{1,2}$/.test(version) ||
		Bun.semver.order(version, PINNED_VERSION) < 0 ||
		!sha256 ||
		!/^[\da-f]{64}$/.test(sha256)
	) {
		throw new VpnError(`Use core install or core install <version >= ${PINNED_VERSION}> <official archive SHA-256>.`);
	}
	try {
		const url = new URL(`${RELEASE}/v${version}/${archive.name}`);
		const bytes = await fetchVpnBytes(url, { limit: 100 * 1024 * 1024, timeoutSeconds: 45, redirects: true }, proxy);
		if (new Bun.CryptoHasher("sha256").update(bytes).digest("hex") !== sha256)
			throw new VpnError("Xray release checksum mismatch.");
		await using temp = await TempDir.create("@omp-vpn-core-");
		const zip = temp.join("release.zip");
		await Bun.write(zip, bytes);
		const result = await $`unzip -p ${zip} xray`.quiet().nothrow();
		if (result.exitCode !== 0) throw new Error();
		const binaryHash = new Bun.CryptoHasher("sha256").update(result.stdout).digest("hex");
		const filename = binaryPath(binaryHash);
		await using staging = await TempDir.create(path.join(vpnDir(), ".core-"));
		const executable = staging.join("xray");
		await fs.writeFile(executable, result.stdout, { mode: 0o700, flag: "wx" });
		const versionResult = await $`${executable} version`.quiet().nothrow();
		if (versionResult.exitCode !== 0 || !versionResult.text().startsWith(`Xray ${version} `)) throw new Error();
		await fs.rename(executable, filename);
		return { version, sha256: binaryHash };
	} catch (error) {
		if (error instanceof VpnError) throw error;
		throw new VpnError("Xray installation failed. Check HTTPS access to GitHub and availability of unzip.");
	}
}

export interface RunningCore {
	proxy: VpnProbeProxy;
	dataSocket: string;
	version: string;
	exited: Promise<number>;
	isRunning(): boolean;
	stop(): Promise<void>;
}

export async function startCore(
	core: VpnCore | undefined,
	profile: VpnProfile,
	route: Omit<VpnRoute, "dataSocket"> = { id: crypto.randomUUID(), lan: [], localhost: [] },
): Promise<RunningCore> {
	const binary = await verifyCore(core);
	const temp = await TempDir.create("/tmp/omp-vpn-xray-");
	const dataSocket = temp.join("data.sock");
	try {
		const reservation = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
		const proxy = { port: reservation.port, password: crypto.randomUUID() };
		reservation.stop(true);
		const config = xrayConfig(profile, proxy, { ...route, dataSocket });
		const child = Bun.spawn(["setpriv", "--pdeathsig", "KILL", "--", binary, "run", "-config", "stdin:"], {
			stdin: new Blob([JSON.stringify(config)]),
			stdout: "ignore",
			stderr: "ignore",
			cwd: temp.path(),
			env: {},
		});
		const exited = child.exited.finally(() => temp.remove().catch(() => undefined));
		const isRunning = () => child.exitCode === null && child.signalCode === null;
		const running: RunningCore = {
			proxy,
			dataSocket,
			version: core?.version ?? "",
			exited,
			isRunning,
			async stop() {
				if (isRunning()) child.kill("SIGKILL");
				await exited;
			},
		};
		for (let tries = 0; tries < 100 && running.isRunning(); tries++) {
			if ((await fs.stat(dataSocket).catch(() => undefined))?.isSocket()) return running;
			await Bun.sleep(30);
		}
		await running.stop();
	} catch {
		// Xray can echo config fields in startup failures. Keep this error fixed.
	}
	await temp.remove().catch(() => undefined);
	throw new VpnError("Xray could not start with this profile.");
}

export function probeCore(core: RunningCore): Promise<boolean> {
	return probeVpnProxy(core.proxy, new URL(PROBE_URL));
}
