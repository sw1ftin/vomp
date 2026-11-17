"""Set up the agent's Linux namespace and forward its TUN to a private Unix socket."""

import asyncio
import ctypes
import fcntl
import json
import os
from pathlib import Path
import signal
import struct
import subprocess
import sys


def die_with_parent():
    parent = os.getppid()
    if ctypes.CDLL(None, use_errno=True).prctl(1, signal.SIGKILL, 0, 0, 0):
        raise OSError("prctl")
    if parent == 1 or parent != os.getppid():
        os._exit(1)


def configure_network(runtime, tun):
    # TUNSETIFF, IFF_TUN | IFF_NO_PI. Xray reads/writes complete IP packets.
    fcntl.ioctl(tun, 0x400454CA, struct.pack("16sH22x", b"omp0", 0x1001))
    commands = (
        ("ip", "link", "set", "lo", "up"),
        ("ip", "addr", "add", "198.18.0.2/30", "dev", "omp0"),
        ("ip", "-6", "addr", "add", "fd00:6f6d:7000::2/64", "nodad", "dev", "omp0"),
        ("ip", "link", "set", "omp0", "up"),
        ("ip", "route", "add", "default", "dev", "omp0"),
        ("ip", "-6", "route", "add", "default", "dev", "omp0"),
    )
    for command in commands:
        subprocess.run(command, check=True)
    (runtime / "resolv.conf").write_text("nameserver 1.1.1.1\nnameserver 9.9.9.9\noptions timeout:2 attempts:2\n")
    nss = Path("/etc/nsswitch.conf").read_text().splitlines()
    (runtime / "nsswitch.conf").write_text("\n".join(row for row in nss if row.split(":", 1)[0].strip() != "hosts") + "\nhosts: files dns\n")
    for filename in ("resolv.conf", "nsswitch.conf"):
        target = os.path.realpath(Path("/etc") / filename)
        if not os.path.isfile(target):
            raise OSError("missing system resolver configuration")
        subprocess.run(["mount", "--bind", str(runtime / filename), target], check=True)
    # libc can ask the host's nscd over a filesystem socket before consulting NSS.
    empty = runtime / "empty"
    empty.mkdir()
    if os.path.isdir("/run/nscd"):
        subprocess.run(["mount", "--bind", str(empty), "/run/nscd"], check=True)


async def relay(reader, writer, tunnel):
    async def copy(source, destination):
        while chunk := await source.read(65536):
            destination.write(chunk)
            await destination.drain()
        destination.write_eof()

    try:
        upstream_reader, upstream_writer = await asyncio.open_unix_connection(tunnel)
        try:
            async with asyncio.TaskGroup() as tasks:
                tasks.create_task(copy(reader, upstream_writer))
                tasks.create_task(copy(upstream_reader, writer))
        finally:
            upstream_writer.close()
    except (OSError, ExceptionGroup):
        pass
    finally:
        writer.close()


UNPRIVILEGED = ("setpriv", "--no-new-privs", "--bounding-set=-all", "--inh-caps=-all", "--ambient-caps=-all", "--pdeathsig", "KILL", "--")


async def launch(runtime, xray, argv):
    die_with_parent()
    (runtime / "tmp").mkdir(mode=0o700)
    # A host proxy setting can point at a service on the host loopback.
    environment = {key: value for key, value in os.environ.items()
                   if key.lower() not in {"http_proxy", "https_proxy", "all_proxy", "pi_proxy"}}
    environment["TMPDIR"] = str(runtime / "tmp")
    proxy = None
    agent = None
    server = await asyncio.start_server(lambda reader, writer: relay(reader, writer, runtime / "tunnel.sock"), "127.0.0.1", 0)
    async with server:
        try:
            config = json.loads((runtime / "frontend.json").read_bytes())
            config["outbounds"][0]["settings"]["port"] = server.sockets[0].getsockname()[1]
            (runtime / "frontend.json").unlink()
            with open("/dev/net/tun", "r+b", buffering=0) as tun:
                configure_network(runtime, tun)
                proxy = await asyncio.create_subprocess_exec(
                    *UNPRIVILEGED, xray, "run", "-config", "stdin:",
                    stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
                    env={"XRAY_TUN_FD": str(tun.fileno())}, pass_fds=(tun.fileno(),), preexec_fn=die_with_parent)
                proxy.stdin.write(json.dumps(config).encode())
                await proxy.stdin.drain()
                proxy.stdin.close()
            agent = await asyncio.create_subprocess_exec(*UNPRIVILEGED, *argv, env=environment, preexec_fn=die_with_parent)
            loop = asyncio.get_running_loop()
            loop.add_signal_handler(signal.SIGINT, lambda: None)
            loop.add_signal_handler(signal.SIGTERM, lambda: agent.terminate() if agent.returncode is None else None)
            agent_exit = asyncio.create_task(agent.wait())
            proxy_exit = asyncio.create_task(proxy.wait())
            done, _ = await asyncio.wait([agent_exit, proxy_exit], return_when=asyncio.FIRST_COMPLETED)
            if agent_exit in done:
                code = agent_exit.result()
                return code if code >= 0 else 128 - code
            sys.stderr.write("VPN transport process exited. Network remains isolated.\n")
            if agent.returncode is None:
                agent.terminate()
                try:
                    await asyncio.wait_for(agent_exit, 10)
                except TimeoutError:
                    pass
            return 1
        finally:
            for process in (agent, proxy):
                if process is not None and process.returncode is None:
                    process.kill()
                    await process.wait()


try:
    sys.exit(asyncio.run(launch(Path(sys.argv[1]), sys.argv[2], sys.argv[3:])))
except (OSError, subprocess.SubprocessError):
    sys.stderr.write("VPN isolation failed. Check Linux user namespaces, /dev/net/tun, iproute2 and util-linux.\n")
    sys.exit(1)
