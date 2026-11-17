import * as fs from "node:fs/promises";
import { $ } from "bun";
import { TempDir } from "@oh-my-pi/pi-utils/temp";
import { VpnManager, type VpnRequest, type VpnStatus, describeVpn, formatVpnStatus } from "./manager";
import namespaceLauncher from "./namespace.py" with { type: "text" };
import { readVpnState } from "./store";
import { verifyCore } from "./core";
import { PROBE_URL, VpnError, frontendConfig } from "./subscription";

const CHECK_INTERVAL = 30_000;
const localFetch = fetch;
const localManager = new VpnManager();

export function hasVpnNamespace(): boolean {
	return Boolean(process.env._OMP_VPN_SOCKET);
}

async function requestRemote(request: VpnRequest, timeout = 120_000): Promise<VpnStatus> {
	const unix = process.env._OMP_VPN_SOCKET;
	if (!unix) throw new VpnError("VPN control socket is unavailable.");
	try {
		const response = await localFetch("http://vpn.internal/", {
			unix,
			method: "POST",
			body: JSON.stringify(request),
			signal: AbortSignal.timeout(timeout),
		});
		const result = (await response.json()) as { status: VpnStatus; error?: string };
		if (!response.ok) throw new VpnError(result.error || "VPN operation failed.");
		return result.status;
	} catch (error) {
		if (error instanceof VpnError) throw error;
		throw new VpnError("VPN gateway is unavailable. Network remains isolated.");
	}
}

export async function requestVpn(request: VpnRequest): Promise<VpnStatus> {
	if (process.platform !== "linux") throw new VpnError("Managed VPN requires Linux.");
	const status = await (hasVpnNamespace() ? requestRemote(request) : localManager.execute(request));
	if (request.command === "doctor") {
		const probe =
			await $`curl -q --silent --fail --max-time 10 --noproxy '*' --output /dev/null --write-out '%{http_code}' ${PROBE_URL}`
				.quiet()
				.nothrow();
		if (probe.exitCode !== 0 || probe.text() !== "204")
			throw new VpnError("Xray responds but the isolated DNS/HTTPS check failed.");
	}
	return status;
}

export function safeVpnError(error: unknown): string {
	return error instanceof VpnError ? error.message : "VPN operation failed.";
}

async function runIsolated(runtime: TempDir, binary: string, argv: string[]): Promise<number> {
	const tunnelSocket = runtime.join("tunnel.sock");
	const id = crypto.randomUUID();
	await fs.writeFile(runtime.join("frontend.json"), JSON.stringify(frontendConfig(id)), {
		mode: 0o600,
		flag: "wx",
	});
	const manager = new VpnManager({ tunnelSocket, id });
	try {
		await manager.initialize();
		const server = Bun.serve({
			unix: runtime.join("control.sock"),
			maxRequestBodySize: 8192,
			async fetch(request, server) {
				server.timeout(request, 120);
				if (request.method !== "POST") return new Response(null, { status: 405 });
				try {
					const input = (await request.json()) as VpnRequest | null;
					if (
						!input ||
						typeof input.command !== "string" ||
						(input.url !== undefined && typeof input.url !== "string") ||
						(input.args !== undefined &&
							(!Array.isArray(input.args) || input.args.some(arg => typeof arg !== "string")))
					) {
						return Response.json({ error: "Invalid VPN request." }, { status: 400 });
					}
					return Response.json({ status: await manager.execute(input) });
				} catch (error) {
					return Response.json({ error: safeVpnError(error) }, { status: 400 });
				}
			},
		});
		let checking = false;
		const timer = setInterval(() => {
			if (checking) return;
			checking = true;
			void manager
				.tick()
				.catch(() => undefined)
				.finally(() => {
					checking = false;
				});
		}, CHECK_INTERVAL);
		try {
			const child = Bun.spawn(
				[
					"unshare",
					"--user",
					"--map-current-user",
					"--keep-caps",
					"--net",
					"--mount",
					"--propagation",
					"private",
					"python3",
					"-c",
					namespaceLauncher,
					runtime.path(),
					binary,
					...argv,
				],
				{
					stdin: "inherit",
					stdout: "inherit",
					stderr: "inherit",
					env: {
						...process.env,
						_OMP_VPN_RUNTIME: runtime.path(),
						_OMP_VPN_SOCKET: runtime.join("control.sock"),
						_OMP_VPN_HOST_NET: await fs.readlink("/proc/self/ns/net"),
					},
				},
			);
			const forward = () => child.kill("SIGTERM");
			const ignoreInterrupt = () => undefined;
			process.on("SIGTERM", forward);
			process.on("SIGINT", ignoreInterrupt);
			try {
				return await child.exited;
			} finally {
				process.removeListener("SIGTERM", forward);
				process.removeListener("SIGINT", ignoreInterrupt);
			}
		} finally {
			clearInterval(timer);
			void server.stop(true);
		}
	} finally {
		await manager.close();
	}
}

async function runVpnCli(argv: string[]): Promise<void> {
	const [command = "status", ...args] = argv;
	if (command === "--help" || command === "-h" || command === "help") {
		process.stdout.write(
			"Usage: omp vpn <status|list|add|connect|disconnect|off|doctor|refresh|allow|deny|core>\nPass an HTTPS subscription URL on stdin to omp vpn add.\n",
		);
		return;
	}
	let url: string | undefined;
	if (command === "add") {
		if (args.length > 0 || process.stdin.isTTY)
			throw new VpnError("Use /vpn add for masked entry or pass one HTTPS URL on stdin.");
		const reader = Bun.stdin.stream().getReader();
		const decoder = new TextDecoder();
		try {
			url = "";
			for (let result = await reader.read(); !result.done; result = await reader.read()) {
				url += decoder.decode(result.value, { stream: true });
				if (url.length > 4096) throw new VpnError("Subscription URL is too long.");
			}
			url += decoder.decode();
		} finally {
			await reader.cancel().catch(() => undefined);
		}
	}
	const status = await requestVpn({ command: command === "list" ? "status" : command, args, url });
	const output =
		command === "list"
			? status.profiles.map(profile => `${profile.id}  ${profile.label}`).join("\n")
			: describeVpn(status);
	process.stdout.write(`${output}\n`);
}

/** Called only by the CLI's main thread, after resolving the omp profile. */
export async function bootstrapVpn(argv: string[], originalArgv: string[], compiled: boolean): Promise<boolean> {
	try {
		if (hasVpnNamespace()) {
			const host = process.env._OMP_VPN_HOST_NET;
			if (!host || (await fs.readlink("/proc/self/ns/net")) === host) {
				throw new VpnError("VPN network namespace was not applied.");
			}
		}
		if (argv[0] === "vpn") {
			await runVpnCli(argv.slice(1));
			return true;
		}
		if (process.platform !== "linux") return false;
		if (hasVpnNamespace()) return false;
		const state = await readVpnState();
		if (!state.protected) return false;
		if (process.getuid?.() === 0) throw new VpnError("Launch managed VPN as an unprivileged user.");
		const binary = await verifyCore(state.core);
		await using runtime = await TempDir.create("/tmp/omp-vpn-");
		const entry = compiled ? [process.execPath] : [process.execPath, Bun.main];
		process.exitCode = await runIsolated(runtime, binary, [...entry, ...originalArgv]);
		return true;
	} catch (error) {
		process.stderr.write(`${safeVpnError(error)}\n`);
		process.exitCode = 1;
		return true;
	}
}

export function watchVpnStatus(setStatus: (value?: string) => void): () => void {
	if (!hasVpnNamespace()) return () => undefined;
	let active = true;
	let last: string | undefined;
	const update = async () => {
		const status = await requestRemote({ command: "status" }, 2000).then(formatVpnStatus, () => "VPN · blocked");
		if (active && status !== last) {
			last = status;
			setStatus(status);
		}
	};
	void update();
	const timer = setInterval(() => void update(), 2000);
	return () => {
		active = false;
		clearInterval(timer);
	};
}
