#!/usr/bin/env python3
"""Run socket tests against an isolated localhost host and always stop it."""
import os
from pathlib import Path
import signal
import socket
import subprocess
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]

def main():
    with socket.socket() as probe:
        if probe.connect_ex(('127.0.0.1', 17891)) == 0:
            raise SystemExit('Port 17891 is already occupied. Stop the existing fixture before testing.')
    subprocess.run(['dotnet', 'build', 'tests/Host/Host.csproj', '-c', 'Release', '--nologo'], cwd=ROOT, check=True)
    logs = ROOT / '.artifacts'
    logs.mkdir(exist_ok=True)
    with (logs / 'integration-host.log').open('w') as log:
        host = subprocess.Popen(['dotnet', 'tests/Host/bin/Release/net10.0/Host.dll'], cwd=ROOT,
                                stdout=log, stderr=subprocess.STDOUT, start_new_session=os.name != 'nt')
        try:
            deadline = time.monotonic() + 45
            while time.monotonic() < deadline:
                if host.poll() is not None:
                    raise RuntimeError('Test host exited. See .artifacts/integration-host.log.')
                try:
                    with urllib.request.urlopen('http://127.0.0.1:17891/JellyfinParty/Rooms', timeout=1):
                        pass
                except urllib.error.HTTPError as error:
                    if error.code == 401:
                        break
                except (urllib.error.URLError, TimeoutError):
                    pass
                time.sleep(0.2)
            else:
                raise RuntimeError('Test host did not become ready within 45 seconds.')
            subprocess.run(['node', 'tests/integration.mjs'], cwd=ROOT, check=True, timeout=90)
        finally:
            if host.poll() is None:
                if os.name == 'nt':
                    host.terminate()
                else:
                    os.killpg(host.pid, signal.SIGTERM)
                try:
                    host.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    if os.name == 'nt': host.kill()
                    else: os.killpg(host.pid, signal.SIGKILL)
                    host.wait()

if __name__ == '__main__':
    main()
