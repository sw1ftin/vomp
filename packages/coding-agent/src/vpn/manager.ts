import * as fs from "node:fs/promises";
import { type RunningCore, installCore, probeCore, startCore } from "./core";
import { type VpnState, readVpnState, updateVpnState } from "./store";
import {
	HOST_LOOPBACK,
	REFRESH_INTERVAL,
	type VpnProfile,
	VpnError,
	downloadSubscription,
	parseException,
} from "./subscription";

export const VPN_ALIASES = ["proxy", "tunnel"];

export interface VpnStatus {
	state: "connected" | "unhealthy" | "blocked" | "restart" | "off";
	active?: string;
	last?: string;
	core?: string;
	profiles: { id: string; label: string }[];
	subscriptions: { id: string; updatedAt: number; refreshFailed?: boolean }[];
	localhost: string[];
	lan: string[];
}

export interface VpnRequest {
	command: string;
	args?: string[];
	url?: string;
}

interface ActiveProfile {
	profile: VpnProfile;
	core: RunningCore;
	coreDigest?: string;
	localhost: string[];
	lan: string[];
	unhealthy: boolean;
}

export function formatVpnStatus(status: VpnStatus): string {
	switch (status.state) {
		case "connected":
			return `VPN · ${status.active}`;
		case "unhealthy":
			return `VPN · ${status.active} · check failed`;
		case "blocked":
			return "VPN · blocked";
		case "restart":
			return "VPN · restart omp to apply";
		case "off":
			return "VPN · off";
	}
}

function profiles(state: VpnState): VpnProfile[] {
	return state.subscriptions.flatMap(subscription => subscription.profiles);
}

export class VpnManager {
	#active?: ActiveProfile;
	#operation = Promise.resolve();
	#closed = false;

	constructor(readonly gateway?: { tunnelSocket: string; id: string }) {}

	#status(state: VpnState): VpnStatus {
		const active = this.#active?.core.isRunning() ? this.#active : undefined;
		return {
			state: this.gateway
				? active
					? active.unhealthy
						? "unhealthy"
						: "connected"
					: "blocked"
				: state.protected
					? "restart"
					: "off",
			active: active?.profile.label,
			last: state.lastProfile,
			core: active?.core.version ?? state.core?.version,
			profiles: profiles(state).map(({ id, label }) => ({ id, label })),
			subscriptions: state.subscriptions.map(({ id, updatedAt, refreshFailed }) => ({
				id,
				updatedAt,
				refreshFailed,
			})),
			localhost: active?.localhost ?? state.localhost,
			lan: active?.lan ?? state.lan,
		};
	}

	async #switch(state: VpnState, profile: VpnProfile): Promise<void> {
		const gateway = this.gateway;
		if (this.#closed) throw new VpnError("VPN gateway is shutting down.");
		const candidate = await startCore(
			state.core,
			profile,
			gateway ? { localhost: state.localhost, lan: state.lan, id: gateway.id } : undefined,
		);
		try {
			if (!(await probeCore(candidate)) || !candidate.isRunning() || this.#closed) {
				throw new VpnError(
					this.#active?.core.isRunning()
						? "Profile check failed. The previous VPN connection was kept."
						: "Profile check failed. Could not reach the HTTPS check endpoint.",
				);
			}
			if (!gateway) return;
			const next = `${gateway.tunnelSocket}.next`;
			try {
				await fs.symlink(candidate.dataSocket, next);
				await fs.rename(next, gateway.tunnelSocket);
			} finally {
				await fs.rm(next, { force: true }).catch(() => undefined);
			}
			const previous = this.#active;
			this.#active = {
				core: candidate,
				profile,
				coreDigest: state.core?.sha256,
				localhost: [...state.localhost],
				lan: [...state.lan],
				unhealthy: false,
			};
			await previous?.core.stop();
		} finally {
			if (this.#active?.core !== candidate) await candidate.stop();
		}
	}

	async #refresh(state: VpnState, automatic: boolean): Promise<void> {
		const now = Date.now();
		let failures = 0;
		const proxy = this.#active?.core.proxy;
		if (this.gateway && !this.#active?.core.isRunning())
			throw new VpnError("Connect a profile before refreshing subscriptions.");
		for (const subscription of state.subscriptions) {
			if (
				automatic &&
				now - (subscription.attemptedAt ?? subscription.updatedAt) <
					(subscription.refreshFailed ? 60 * 60 * 1000 : REFRESH_INTERVAL)
			)
				continue;
			subscription.attemptedAt = Date.now();
			try {
				subscription.profiles = await downloadSubscription(subscription.url, subscription.id, proxy);
				subscription.updatedAt = Date.now();
				subscription.refreshFailed = false;
			} catch {
				subscription.refreshFailed = true;
				failures++;
			}
		}
		if (failures && !automatic)
			throw new VpnError("Some subscriptions could not be refreshed. Their cached profiles were kept.");
	}

	initialize(): Promise<void> {
		return this.#serialize(async () => {
			const state = await readVpnState();
			const profile = profiles(state).find(profile => profile.id === state.lastProfile);
			if (state.connectOnLaunch && profile) await this.#switch(state, profile).catch(() => undefined);
		});
	}

	tick(): Promise<void> {
		return this.#serialize(async () => {
			const active = this.#active;
			if (!active?.core.isRunning()) return;
			active.unhealthy = !(await probeCore(active.core));
			if (active.unhealthy) return;
			const state = await readVpnState();
			const now = Date.now();
			if (
				state.subscriptions.some(
					sub =>
						now - (sub.attemptedAt ?? sub.updatedAt) >= (sub.refreshFailed ? 60 * 60 * 1000 : REFRESH_INTERVAL),
				)
			) {
				await updateVpnState(state => this.#refresh(state, true));
			}
		});
	}

	#serialize<T>(task: () => Promise<T>): Promise<T> {
		const turn = this.#operation.then(task);
		this.#operation = turn.then(
			() => undefined,
			() => undefined,
		);
		return turn;
	}

	async execute(request: VpnRequest): Promise<VpnStatus> {
		if (request.command === "status") return this.#status(await readVpnState());
		return this.#serialize(async () => {
			const args = request.args ?? [];
			if (request.command === "doctor") {
				if (!this.#active?.core.isRunning())
					throw new VpnError(
						"No live Xray tunnel in this omp process. Connect a profile and relaunch if prompted.",
					);
				this.#active.unhealthy = !(await probeCore(this.#active.core));
				if (this.#active.unhealthy) throw new VpnError("HTTPS probe through Xray failed.");
				return this.#status(await readVpnState());
			}
			let refreshError: VpnError | undefined;
			const status = await updateVpnState(async state => {
				switch (request.command) {
					case "add": {
						const url = request.url?.trim();
						if (!url) throw new VpnError("Enter a subscription URL in the masked prompt.");
						if (this.gateway && !this.#active?.core.isRunning())
							throw new VpnError("Connect first, or import from a host terminal with omp vpn add.");
						const existing = state.subscriptions.find(sub => sub.url === url);
						const id = existing?.id ?? crypto.randomUUID().slice(0, 8);
						const profiles = await downloadSubscription(url, id, this.#active?.core.proxy);
						const updated = { url, id, profiles, updatedAt: Date.now() };
						if (existing) Object.assign(existing, updated, { refreshFailed: false, attemptedAt: undefined });
						else state.subscriptions.push(updated);
						break;
					}
					case "refresh":
						try {
							await this.#refresh(state, false);
						} catch (error) {
							if (error instanceof VpnError) refreshError = error;
							else throw error;
						}
						break;
					case "connect": {
						const available = profiles(state);
						const selection = args[0] || state.lastProfile;
						const profile =
							available.find(profile => profile.id === selection) ??
							(!selection && available.length === 1 ? available[0] : undefined);
						if (!profile) throw new VpnError("Select a profile from /vpn or pass its ID to vpn connect.");
						if (!state.core && !this.gateway) state.core = await installCore();
						if (
							this.#active?.profile.id !== profile.id ||
							!this.#active.core.isRunning() ||
							this.#active.unhealthy ||
							this.#active.coreDigest !== state.core?.sha256 ||
							JSON.stringify(this.#active.localhost) !== JSON.stringify(state.localhost) ||
							JSON.stringify(this.#active.lan) !== JSON.stringify(state.lan) ||
							JSON.stringify(this.#active.profile.outbound) !== JSON.stringify(profile.outbound)
						) {
							await this.#switch(state, profile);
						}
						state.lastProfile = profile.id;
						state.protected = true;
						state.connectOnLaunch = true;
						break;
					}
					case "disconnect":
					case "off": {
						const active = this.#active;
						if (this.gateway) await fs.rm(this.gateway.tunnelSocket, { force: true });
						this.#active = undefined;
						await active?.core.stop();
						state.connectOnLaunch = false;
						if (request.command === "off") state.protected = false;
						break;
					}
					case "allow":
					case "deny": {
						const [kind, value] = args;
						const entry = parseException(kind, value ?? "");
						const key = kind === "localhost" ? "localhost" : "lan";
						const entries = state[key].filter(item => item !== entry);
						if (request.command === "allow") entries.push(entry);
						if (
							entries.length === state[key].length &&
							state[key].includes(entry) === (request.command === "allow")
						)
							break;
						state[key] = entries;
						const active = this.#active;
						if (active?.core.isRunning()) await this.#switch(state, active.profile);
						break;
					}
					case "core":
						if (args[0] !== "install") throw new VpnError("Use vpn core install [version SHA-256].");
						if (this.gateway && !this.#active?.core.isRunning())
							throw new VpnError("Connect first, or install from a host terminal with omp vpn core install.");
						state.core = await installCore(args[1], args[2], this.#active?.core.proxy);
						break;
					default:
						throw new VpnError(
							"Use vpn status, list, add, connect, disconnect, off, doctor, refresh, allow, deny, or core install.",
						);
				}
				return this.#status(state);
			});
			if (refreshError) throw refreshError;
			return status;
		});
	}

	async close(): Promise<void> {
		this.#closed = true;
		await this.#active?.core.stop();
	}
}

export function describeVpn(status: VpnStatus): string {
	const subscriptions = status.subscriptions.map(
		sub =>
			`${sub.id} ${new Date(sub.updatedAt).toISOString().slice(0, 16)}Z${sub.refreshFailed ? " (refresh failed)" : ""}`,
	);
	return [
		formatVpnStatus(status),
		`Xray ${status.core ?? "not installed"}`,
		`Subscriptions ${subscriptions.join(", ") || "none"}`,
		`Host loopback ${status.localhost.map(port => `${HOST_LOOPBACK}:${port}`).join(", ") || "none"}`,
		`Direct LAN ${status.lan.join(", ") || "none"}`,
	].join("\n");
}
