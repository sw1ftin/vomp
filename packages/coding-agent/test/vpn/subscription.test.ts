import { describe, expect, test } from "bun:test";
import { parseException, parseSubscription } from "../../src/vpn/subscription";

const USER = "00000000-0000-4000-8000-000000000001";
const KEY = "synthetic-reality-key-never-use-in-a-real-config";
const REALITY = `vless://${USER}@one.example:443?type=tcp&security=reality&flow=xtls-rprx-vision&pbk=${KEY}&sni=cover.example&sid=0102`;

describe("VPN subscription imports", () => {
	test("converts each usable Base64 entry into its own Xray outbound", () => {
		const tls = `vless://${USER}@two.example:443?security=tls&alpn=h2#TLS`;
		const body = Buffer.from(`${REALITY}#Vision\r\ninvalid\r\n${REALITY}#Vision\r\n${tls}`).toString("base64");
		const entries = parseSubscription(body, "test");
		expect(entries.map(profile => profile.label)).toEqual(["Vision", "TLS"]);
		expect(entries[0].outbound).toMatchObject({
			settings: { vnext: [{ address: "one.example", users: [{ id: USER, flow: "xtls-rprx-vision" }] }] },
			streamSettings: { network: "raw", security: "reality", realitySettings: { password: KEY, shortId: "0102" } },
		});
		expect(entries[1].outbound.streamSettings).toMatchObject({ security: "tls", tlsSettings: { alpn: ["h2"] } });
	});

	test("keeps provider credentials and terminal control codes out of labels", () => {
		const label = encodeURIComponent(`Local\tProfile\u202e ${USER} ${KEY}`);
		const [entry] = parseSubscription(`${REALITY}#${label}`, "test");
		expect(entry.label).toBe("Local Profile");
	});

	test("rejects subscriptions that only offer unsupported transports", () => {
		expect(() => parseSubscription(REALITY.replace("type=tcp", "type=ws"), "test")).toThrow(
			"Subscription has no supported VLESS TCP TLS/REALITY profiles.",
		);
	});
});

describe("VPN direct exceptions", () => {
	test("accepts a single loopback port and canonicalizes a private subnet for removal", () => {
		expect(parseException("localhost", "03000")).toBe("3000");
		expect(parseException("lan", "192.168.1.5/24")).toBe("192.168.1.0/24");
	});

	test("rejects a CIDR that would allow public traffic even when its supplied address is private", () => {
		expect(() => parseException("lan", "192.168.1.1/1")).toThrow();
	});
});
