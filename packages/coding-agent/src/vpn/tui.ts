import type { SlashCommandSpec, TuiSlashCommandRuntime } from "../slash-commands/types";
import { parseSlashCommand } from "../slash-commands/helpers/parse";
import { requestVpn, safeVpnError } from "./control";
import { VPN_ALIASES, type VpnRequest, describeVpn, formatVpnStatus } from "./manager";

export function isVpnCommand(text: string): boolean {
	const name = parseSlashCommand(text.trim())?.name;
	return name === "vpn" || (name !== undefined && VPN_ALIASES.includes(name));
}

export async function runVpnTui(text: string, { ctx }: TuiSlashCommandRuntime): Promise<void> {
	const [command, ...args] = (parseSlashCommand(text.trim())?.args ?? "").split(/\s+/);
	if (ctx.collabGuest) {
		ctx.showStatus("/vpn is available in the local host terminal.");
		return;
	}
	const ui = ctx.getToolUIContext();
	try {
		if (command === "add" && args.length > 0) {
			ctx.showError("Use /vpn add and paste the URL in the masked prompt.");
			return;
		}
		const status = await requestVpn({ command: "status" });
		let request: VpnRequest = { command, args };
		if (!command || command === "list") {
			if (command === "list" && status.profiles.length === 0) {
				ctx.showStatus("No VPN profiles. Use /vpn add to import a subscription.");
				return;
			}
			const choices = status.profiles.map(profile => ({
				label: `${profile.label}  [${profile.id}]`,
				description: profile.id === status.last ? "Last selected" : undefined,
			}));
			const actions =
				command === "list"
					? []
					: [
							{ label: "Add subscription", description: "Enter an HTTPS URL in a masked prompt" },
							{ label: "Diagnostics", description: "Test DNS and HTTPS through the active profile" },
							{ label: "Refresh subscriptions" },
							{ label: "Install pinned Xray core" },
							{ label: "Disconnect", description: "Keep network isolation active" },
							{ label: "Status and network exceptions" },
						];
			const selected = await ui?.select(formatVpnStatus(status), [...actions, ...choices]);
			if (!selected) return;
			switch (selected) {
				case "Add subscription":
					request = { command: "add" };
					break;
				case "Diagnostics":
					request = { command: "doctor" };
					break;
				case "Refresh subscriptions":
					request = { command: "refresh" };
					break;
				case "Install pinned Xray core":
					request = { command: "core", args: ["install"] };
					break;
				case "Disconnect":
					request = { command: "disconnect" };
					break;
				case "Status and network exceptions":
					request = { command: "status" };
					break;
				default: {
					const profile = status.profiles[choices.findIndex(choice => choice.label === selected)];
					if (!profile) return;
					request = { command: "connect", args: [profile.id] };
				}
			}
		}
		if (request.command === "add") {
			const url = await ui?.input("HTTPS subscription URL", undefined, { secret: true });
			if (!url) return;
			request.url = url;
		}
		if (request.command === "connect") ctx.showStatus("Checking VPN profile…");
		const changed = request.command === "status" ? status : await requestVpn(request);
		if (request.command === "status") ctx.showStatus(describeVpn(changed));
		else if (request.command === "off" && changed.state === "blocked")
			ctx.showStatus("VPN disabled for the next launch. This process remains isolated.");
		else if (request.command === "core") ctx.showStatus("Xray installed. Reconnect the profile to use it.");
		else if (request.command === "add")
			ctx.showStatus(`Subscription saved. ${changed.profiles.length} profiles available in /vpn.`);
		else if (request.command === "refresh") ctx.showStatus("Subscriptions refreshed.");
		else if (request.command === "doctor") ctx.showStatus(`${formatVpnStatus(changed)} · DNS and HTTPS passed`);
		else ctx.showStatus(formatVpnStatus(changed));
		ctx.setHookStatus("vpn", changed.state === "off" ? undefined : formatVpnStatus(changed));
	} catch (error) {
		ctx.showError(safeVpnError(error));
	}
}

export const VPN_SLASH_COMMAND: SlashCommandSpec = {
	name: "vpn",
	aliases: VPN_ALIASES,
	description: "Manage the Xray VPN and choose a profile",
	allowArgs: true,
	subcommandOptional: true,
	subcommands: [
		{ name: "add", description: "Import an HTTPS subscription in a masked prompt" },
		{ name: "list", description: "Choose a VPN profile" },
		{ name: "connect", description: "Connect the last or selected profile", usage: "[profile-id]" },
		{ name: "disconnect", description: "Disconnect and keep the kill switch active" },
		{ name: "off", description: "Disable VPN isolation on next launch" },
		{ name: "status", description: "Display VPN state and network exceptions" },
		{ name: "doctor", description: "Check isolated DNS and HTTPS" },
		{ name: "refresh", description: "Refresh subscriptions" },
		{
			name: "allow",
			description: "Allow a host localhost port or local CIDR",
			usage: "localhost <port> | lan <CIDR>",
		},
		{ name: "deny", description: "Remove a network exception", usage: "localhost <port> | lan <CIDR>" },
		{ name: "core", description: "Install a verified Xray release", usage: "install [version SHA-256]" },
	],
	handleTui: ({ text }, runtime) => runVpnTui(text, runtime),
	async handle(command, runtime) {
		const [action = "status", ...args] = command.args ? command.args.split(/\s+/) : [];
		if (action === "add") {
			await runtime.output("Use /vpn add in the local TUI for masked entry or omp vpn add with the URL on stdin.");
			return;
		}
		try {
			const status = await requestVpn({ command: action === "list" ? "status" : action, args });
			await runtime.output(
				action === "list"
					? status.profiles.map(profile => `${profile.id}  ${profile.label}`).join("\n")
					: describeVpn(status),
			);
		} catch (error) {
			await runtime.output(safeVpnError(error));
		}
	},
};
