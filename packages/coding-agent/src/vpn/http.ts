export interface VpnProbeProxy {
	port: number;
	password: string;
}

async function fetchThroughProxy(
	proxy: VpnProbeProxy,
	url: URL,
	options: { limit: number; timeoutSeconds: number; redirects?: boolean; userAgent?: string },
): Promise<{ bytes: Uint8Array; status: number }> {
	const curl = Bun.spawn(
		[
			"curl",
			"-q",
			"--silent",
			"--fail",
			"--noproxy",
			"",
			"--proto",
			"=https",
			"--proto-redir",
			"=https",
			"--max-time",
			String(options.timeoutSeconds),
			"--max-filesize",
			String(options.limit),
			"--proxy",
			`http://127.0.0.1:${proxy.port}`,
			"--write-out",
			"%{http_code}",
			...(options.redirects ? ["--location", "--max-redirs", "5"] : []),
			...(options.userAgent ? ["--user-agent", options.userAgent] : []),
			"--config",
			"-",
		],
		{
			// curl's config comes from stdin to keep both credentials and URLs out of argv.
			stdin: new Blob([`url = ${JSON.stringify(url.href)}\nproxy-user = "omp:${proxy.password}"\n`]),
			stdout: "pipe",
			stderr: "ignore",
		},
	);
	try {
		const result = await readBounded(curl.stdout, options.limit + 3);
		if ((await curl.exited) || result.byteLength < 3) throw new Error();
		return { bytes: result.subarray(0, -3), status: Number(Buffer.from(result.subarray(-3)).toString()) };
	} finally {
		if (curl.exitCode === null) curl.kill("SIGKILL");
	}
}

export async function fetchVpnBytes(
	url: URL,
	options: { limit: number; timeoutSeconds: number; redirects?: boolean; userAgent?: string },
	proxy?: VpnProbeProxy,
): Promise<Uint8Array> {
	if (proxy) {
		const { bytes, status } = await fetchThroughProxy(proxy, url, options);
		if (status < 200 || status >= 300) throw new Error();
		return bytes;
	}
	const response = await fetch(url, {
		redirect: options.redirects ? "follow" : "error",
		signal: AbortSignal.timeout(options.timeoutSeconds * 1000),
		headers: options.userAgent ? { "user-agent": options.userAgent } : undefined,
	});
	if (!response.ok || !response.body) throw new Error();
	return readBounded(response.body, options.limit);
}

export async function probeVpnProxy(proxy: VpnProbeProxy, url: URL): Promise<boolean> {
	try {
		const { status } = await fetchThroughProxy(proxy, url, { limit: 8192, timeoutSeconds: 10 });
		return status === 204;
	} catch {
		return false;
	}
}

async function readBounded(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];
	let length = 0;
	for await (const chunk of stream) {
		length += chunk.byteLength;
		if (length > limit) throw new Error();
		chunks.push(chunk);
	}
	return Buffer.concat(chunks, length);
}
