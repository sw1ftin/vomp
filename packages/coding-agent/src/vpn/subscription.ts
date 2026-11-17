import { isIP } from "node:net";
import { type VpnProbeProxy, fetchVpnBytes } from "./http";

const MAX_BYTES = 1024 * 1024;
export const REFRESH_INTERVAL = 24 * 60 * 60 * 1000;
export const PROBE_URL = "https://www.gstatic.com/generate_204";
export const HOST_LOOPBACK = "192.0.2.1";

export interface VpnProfile {
	id: string;
	label: string;
	outbound: XrayOutbound;
}

type XrayOutbound = {
	tag: string;
	protocol: string;
	settings?: object;
	streamSettings?: object;
};

export class VpnError extends Error {}

/** Fit provider-supplied labels on one terminal row and strip common credential shapes. */
function profileLabel(fragment: string, secrets: string[], index: number): string {
	let label = decodeURIComponent(fragment).normalize("NFC");
	for (const secret of secrets) if (secret) label = label.replaceAll(secret, "");
	if (/\b\w+:\/\/|[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}|[\w-]{32,}/i.test(label)) label = "";
	return (
		Array.from(label.replace(/[\p{C}\p{Z}]+/gu, " ").trim())
			.slice(0, 72)
			.join("") || `Profile ${index}`
	);
}

function vlessOutbound(url: URL): XrayOutbound | undefined {
	const address = url.hostname.replace(/^\[|\]$/g, "");
	const port = Number(url.port);
	const id = decodeURIComponent(url.username);
	const query = url.searchParams;
	const network = query.get("type") || "tcp";
	const security = query.get("security") || "none";
	const flow = query.get("flow") || "";
	const encryption = query.get("encryption") || "none";
	if (!address || !port || url.password || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id)) return;
	if (network !== "tcp" && network !== "raw") return;
	if (query.has("headerType") && query.get("headerType") !== "none") return;
	if (security !== "tls" && security !== "reality") return;
	if (flow && flow !== "xtls-rprx-vision") return;
	if (encryption !== "none" || query.get("allowInsecure") === "1") return;
	const serverName = query.get("sni") || address;
	const fingerprint = query.get("fp") || "chrome";
	const password = query.get("pbk");
	if (security === "reality" && !password) return;
	return {
		tag: "vpn",
		protocol: "vless",
		settings: { vnext: [{ address, port, users: [{ id, encryption, flow }] }] },
		streamSettings: {
			network: "raw",
			security,
			...(security === "reality"
				? {
						realitySettings: {
							serverName,
							fingerprint,
							password,
							shortId: query.get("sid") || "",
							spiderX: query.get("spx") || "/",
						},
					}
				: { tlsSettings: { serverName, fingerprint, alpn: query.get("alpn")?.split(",") } }),
		},
	};
}

export function parseSubscription(body: string, subscriptionId: string, secretUrl = ""): VpnProfile[] {
	let text = body.trim();
	if (/^[A-Za-z0-9+/=_\-\s]+$/.test(text)) text = Buffer.from(text, "base64").toString("utf8");
	const profiles: VpnProfile[] = [];
	const seen = new Set<string>();
	const occurrences = new Map<string, number>();
	for (const line of text.split(/\r?\n/)) {
		try {
			const url = new URL(line.trim());
			if (url.protocol !== "vless:") continue;
			const outbound = vlessOutbound(url);
			if (!outbound || seen.has(url.href)) continue;
			const label = profileLabel(
				url.hash.slice(1),
				[secretUrl, url.username, ...url.searchParams.values()].filter(value => value.length >= 8),
				profiles.length + 1,
			);
			const identity = `${url.hostname}:${url.port}:${label}`;
			const occurrence = (occurrences.get(identity) ?? 0) + 1;
			occurrences.set(identity, occurrence);
			const id = new Bun.CryptoHasher("sha256")
				.update(`${subscriptionId}:${identity}:${occurrence}`)
				.digest("hex")
				.slice(0, 12);
			profiles.push({ id, label, outbound });
			seen.add(url.href);
		} catch {
			// Individual malformed entries can coexist with usable profiles.
		}
	}
	if (profiles.length === 0) throw new VpnError("Subscription has no supported VLESS TCP TLS/REALITY profiles.");
	return profiles;
}

export async function downloadSubscription(rawUrl: string, id: string, proxy?: VpnProbeProxy): Promise<VpnProfile[]> {
	let url: URL;
	try {
		url = new URL(rawUrl);
		if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error();
	} catch {
		throw new VpnError("Enter an HTTPS subscription URL.");
	}
	try {
		const bytes = await fetchVpnBytes(url, { limit: MAX_BYTES, timeoutSeconds: 15, userAgent: "v2rayN" }, proxy);
		return parseSubscription(Buffer.from(bytes).toString("utf8"), id, rawUrl);
	} catch (error) {
		if (error instanceof VpnError) throw error;
		throw new VpnError("Could not download subscription over HTTPS.");
	}
}

/** LAN forwarding is opt-in and constrained to local address space. */
export function parseException(kind: string, value: string): string {
	if (kind === "localhost" && /^\d{1,5}$/.test(value) && Number(value) > 0 && Number(value) <= 65535)
		return String(Number(value));
	if (kind === "lan") {
		const [ip, prefixText, extra] = value.split("/");
		const prefix = prefixText === undefined ? 32 : Number(prefixText);
		if (
			extra === undefined &&
			isIP(ip) === 4 &&
			(prefixText === undefined || /^\d{1,2}$/.test(prefixText)) &&
			prefix <= 32
		) {
			const octets = ip.split(".").map(Number);
			const [first, second] = octets;
			if (
				(first === 10 && prefix >= 8) ||
				(first === 172 && second >= 16 && second <= 31 && prefix >= 12) ||
				(first === 192 && second === 168 && prefix >= 16) ||
				(first === 169 && second === 254 && prefix >= 16) ||
				(first === 100 && second >= 64 && second <= 127 && prefix >= 10)
			) {
				const network = octets.map((octet, index) => {
					const bits = Math.max(0, Math.min(8, prefix - index * 8));
					return octet & (0xff << (8 - bits));
				});
				return `${network.join(".")}/${prefix}`;
			}
		}
	}
	throw new VpnError("Use a localhost port or an IPv4 address/CIDR within a private LAN range.");
}

export interface VpnRoute {
	localhost: string[];
	lan: string[];
	dataSocket: string;
	id: string;
}

const NO_LOGS = { access: "none", error: "none", loglevel: "none" };

export function frontendConfig(id: string): object {
	return {
		log: NO_LOGS,
		inbounds: [{ protocol: "tun", settings: { name: "omp0", mtu: 1500 } }],
		outbounds: [
			{
				protocol: "vless",
				settings: { address: "127.0.0.1", port: 1, id, encryption: "none" },
			},
		],
	};
}

export function xrayConfig(profile: VpnProfile, probe: VpnProbeProxy, route: VpnRoute): object {
	const outbounds: XrayOutbound[] = [profile.outbound];
	const inbounds = [
		{
			tag: "probe",
			protocol: "http",
			listen: "127.0.0.1",
			port: probe.port,
			settings: { accounts: [{ user: "omp", pass: probe.password }] },
		},
		{
			tag: "tunnel",
			protocol: "vless",
			listen: route.dataSocket,
			settings: { users: [{ id: route.id }], decryption: "none" },
		},
	];
	const rules: object[] = [];
	outbounds.push({ tag: "block", protocol: "blackhole" });
	if (route.localhost.length > 0) {
		outbounds.push({
			tag: "host-loopback",
			protocol: "freedom",
			settings: {
				redirect: "127.0.0.1:0",
				finalRules: [{ action: "allow", ip: ["127.0.0.1"], port: route.localhost.join(",") }],
			},
		});
		rules.push({
			type: "field",
			inboundTag: ["tunnel"],
			ip: [HOST_LOOPBACK],
			port: route.localhost.join(","),
			outboundTag: "host-loopback",
		});
	}
	rules.push({ type: "field", ip: [HOST_LOOPBACK], outboundTag: "block" });
	if (route.lan.length > 0) {
		outbounds.push({
			tag: "lan",
			protocol: "freedom",
			settings: { finalRules: [{ action: "allow", ip: route.lan }] },
		});
		rules.push({ type: "field", inboundTag: ["tunnel"], ip: route.lan, outboundTag: "lan" });
	}
	return { log: NO_LOGS, inbounds, outbounds, routing: { rules } };
}
