# Verifies upload receiver failures restore a real terminal before subsequent interactive input.
import hashlib
import json
import os
from pathlib import Path
import pty
import select
import sys
import termios


def main():
    """Exercises checksum, header, timeout, and interruption failures without any application process or database."""
    scope = {}
    source = Path(__file__).resolve().parents[2] / "python/backend_parts/02_stream_upload.pyfrag"
    exec(compile(source.read_text(), str(source), "exec"), scope)
    scope["_djs_upload_cached"] = lambda *args: None
    master, slave = pty.openpty()
    original_stdin, original_select = sys.__stdin__, select.select
    original_reader = scope["_djs_upload_read_exact"]
    stream = os.fdopen(os.dup(slave), "r")
    sys.__stdin__ = stream
    results = []
    try:
        for failure in ("checksum", "header", "timeout", "interrupt"):
            before = termios.tcgetattr(slave)
            packet = {"feature": "grid", "size": 3, "digest": hashlib.sha256(b"yes").hexdigest()}
            if failure == "header":
                packet["size"] = 1024 * 1024 + 1
            header = json.dumps(packet).encode()

            def send_frame(request_id, stage, size):
                """Writes only after the receiver has disabled echo and canonical input on the actual terminal."""
                active = termios.tcgetattr(slave)
                assert not active[3] & (termios.ECHO | termios.ICANON)
                assert active[3] & termios.ISIG == before[3] & termios.ISIG
                if failure not in ("timeout", "interrupt"):
                    os.write(master, header if stage == "header" else b"bad")

            def interrupted(*args):
                """Simulates SIGINT arriving while the receiver owns stdin."""
                raise KeyboardInterrupt()

            scope["_djs_upload_marker"] = send_frame
            if failure == "timeout":
                select.select = lambda *args: ([], [], [])
            if failure == "interrupt":
                scope["_djs_upload_read_exact"] = interrupted
            try:
                scope["_djs_read_upload"](len(header), "failure-fixture", "grid")
                raise AssertionError("An invalid upload was accepted")
            except (ValueError, TimeoutError, KeyboardInterrupt) as error:
                results.append(type(error).__name__)
            finally:
                select.select = original_select
                scope["_djs_upload_read_exact"] = original_reader
            after = termios.tcgetattr(slave)
            # BSD's PENDIN bit is transient driver state set when canonical input is restored.
            before[3] &= ~getattr(termios, "PENDIN", 0)
            after[3] &= ~getattr(termios, "PENDIN", 0)
            assert after == before, (failure, before, after)
            os.write(master, b"healthy\n")
            assert select.select([slave], [], [], 1)[0]
            assert os.read(slave, 100) == b"healthy\n"
        print(json.dumps(results))
    finally:
        sys.__stdin__ = original_stdin
        select.select = original_select
        stream.close()
        os.close(master)
        os.close(slave)


if __name__ == "__main__":
    main()
